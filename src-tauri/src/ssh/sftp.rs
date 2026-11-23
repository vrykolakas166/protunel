//! SFTP over a tunnel's live session: the file popup's backend.
//!
//! Like a terminal, this never owns a connection. An `sftp` subsystem channel
//! is opened on the tunnel's authenticated `client::Handle` and cached per
//! tunnel; the cache entry is only reused while it belongs to that same session
//! (the supervisor replaces the handle on every reconnect), so an operation can
//! never land on a stale session.
//!
//! Transfer bytes only ever move between this module and the local disk. The
//! webview sees directory listings, and the contents of files it explicitly
//! opens to view or edit (bounded by `MAX_TEXT_BYTES` / `MAX_IMAGE_BYTES`).

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use russh::client;
use russh::ChannelMsg;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::events::FILE_TRANSFER_EVENT;
use crate::ssh::SshHandler;
use crate::AppState;

/// Largest text file shown or edited in the popup.
pub const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
/// Largest image previewed in the popup.
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// "Last part" of a log too big to show whole.
const TAIL_BYTES: u64 = 1024 * 1024;
/// Transfers running at once, over every host.
const PARALLEL_TRANSFERS: usize = 3;
/// Finished transfers kept for a reloaded webview.
const KEEP_FINISHED: usize = 50;
/// Progress events per transfer, at most.
const PROGRESS_EVERY: Duration = Duration::from_millis(200);
/// Delete counts stop here; the confirmation then says "more than".
pub const COUNT_LIMIT: u64 = 100_000;
const CHUNK: usize = 256 * 1024;

type Handle = client::Handle<SshHandler>;

struct Cached {
    session: Weak<Handle>,
    sftp: Arc<SftpSession>,
}

/// Open SFTP channels and the transfer queue. Managed state.
pub struct Files {
    cache: tokio::sync::Mutex<HashMap<Uuid, Cached>>,
    transfers: Mutex<Transfers>,
    slots: Arc<Semaphore>,
}

impl Default for Files {
    fn default() -> Self {
        Self {
            cache: tokio::sync::Mutex::new(HashMap::new()),
            transfers: Mutex::new(Transfers::default()),
            slots: Arc::new(Semaphore::new(PARALLEL_TRANSFERS)),
        }
    }
}

/// The SFTP channel of a tunnel's current session, opened on first use.
pub async fn sftp_for(app: &AppHandle, tunnel_id: Uuid) -> Result<Arc<SftpSession>, String> {
    let state = app.state::<AppState>();
    let files = app.state::<Files>();
    let session = state.session_for(tunnel_id).ok_or("not-connected")?;
    {
        let cache = files.cache.lock().await;
        if let Some(entry) = cache.get(&tunnel_id) {
            if entry.session.upgrade().is_some_and(|s| Arc::ptr_eq(&s, &session)) {
                return Ok(entry.sftp.clone());
            }
        }
    }
    // Opened without the lock held: a slow server must not block other hosts.
    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("failed to open SFTP channel: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("the server refused SFTP: {e}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("the server refused SFTP: {e}"))?;
    sftp.set_timeout(30);
    let sftp = Arc::new(sftp);
    files.cache.lock().await.insert(
        tunnel_id,
        Cached { session: Arc::downgrade(&session), sftp: sftp.clone() },
    );
    Ok(sftp)
}

/// Drops a tunnel's cached channel after an error that may mean it is dead,
/// so the next call opens a fresh one.
pub async fn forget(app: &AppHandle, tunnel_id: Uuid) {
    app.state::<Files>().cache.lock().await.remove(&tunnel_id);
}

/// Error text for the webview. Codes the UI translates are bare words.
pub fn err(e: SftpError) -> String {
    match e {
        SftpError::Status(s) => match s.status_code {
            StatusCode::NoSuchFile => "no-such-file".to_string(),
            StatusCode::PermissionDenied => "permission-denied".to_string(),
            _ if s.error_message.is_empty() => s.status_code.to_string(),
            _ => s.error_message,
        },
        SftpError::Timeout => "timeout".to_string(),
        other => other.to_string(),
    }
}

fn is_missing(e: &SftpError) -> bool {
    matches!(e, SftpError::Status(s) if s.status_code == StatusCode::NoSuchFile)
}

// ---------------------------------------------------------------------------
// Listing and properties

#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Dir,
    File,
    Symlink,
    Other,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub kind: Kind,
    /// For a symlink: whether it points at a directory (it opens like one).
    pub link_dir: bool,
    pub size: u64,
    pub mtime: Option<u32>,
    /// Permission bits only (no file type), e.g. 0o644.
    pub mode: Option<u32>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
}

fn kind_of(attrs: &FileAttributes) -> Kind {
    if attrs.is_symlink() {
        Kind::Symlink
    } else if attrs.is_dir() {
        Kind::Dir
    } else if attrs.is_regular() {
        Kind::File
    } else {
        Kind::Other
    }
}

fn entry(name: String, attrs: &FileAttributes) -> Entry {
    Entry {
        name,
        kind: kind_of(attrs),
        link_dir: false,
        size: attrs.size.unwrap_or(0),
        mtime: attrs.mtime,
        mode: attrs.permissions.map(|p| p & 0o7777),
        uid: attrs.uid,
        gid: attrs.gid,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// The directory, canonical (symlinks and `..` resolved).
    pub path: String,
    pub entries: Vec<Entry>,
}

pub async fn list(sftp: &SftpSession, path: &str) -> Result<Listing, String> {
    let path = sftp.canonicalize(path).await.map_err(err)?;
    let dir = sftp.read_dir(&path).await.map_err(err)?;
    let mut entries = Vec::new();
    for item in dir {
        let attrs = item.metadata();
        let mut e = entry(item.file_name(), &attrs);
        if e.kind == Kind::Symlink {
            // One stat per link, so a link to a folder opens as one.
            if let Ok(target) = sftp.metadata(join(&path, &e.name)).await {
                e.link_dir = target.is_dir();
            }
        }
        entries.push(e);
    }
    Ok(Listing { path, entries })
}

/// `/a/b` + `c` → `/a/b/c`.
pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// The parent directory and file name of a remote path.
pub fn split(path: &str) -> (&str, &str) {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => ("/", &trimmed[1..]),
        Some(i) => (&trimmed[..i], &trimmed[i + 1..]),
        None => (".", trimmed),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Properties {
    pub path: String,
    #[serde(flatten)]
    pub entry: Entry,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub link_target: Option<String>,
    pub atime: Option<u32>,
}

pub async fn properties(
    session: &Handle,
    sftp: &SftpSession,
    path: &str,
) -> Result<Properties, String> {
    let attrs = sftp.symlink_metadata(path).await.map_err(err)?;
    let (_, name) = split(path);
    let mut e = entry(name.to_string(), &attrs);
    let mut link_target = None;
    if e.kind == Kind::Symlink {
        link_target = sftp.read_link(path).await.ok();
        e.link_dir = sftp.metadata(path).await.is_ok_and(|a| a.is_dir());
    }
    // SFTP v3 only carries ids; names come from the server's own tables.
    let (owner, group) = match (attrs.uid, attrs.gid) {
        (Some(uid), Some(gid)) => names(session, uid, gid).await,
        _ => (None, None),
    };
    Ok(Properties { path: path.to_string(), entry: e, owner, group, link_target, atime: attrs.atime })
}

async fn names(session: &Handle, uid: u32, gid: u32) -> (Option<String>, Option<String>) {
    let cmd = format!("getent passwd {uid} | cut -d: -f1; getent group {gid} | cut -d: -f1");
    let Ok(out) = exec(session, &cmd, Duration::from_secs(5)).await else {
        return (None, None);
    };
    let mut lines = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .collect::<Vec<_>>()
        .into_iter();
    let pick = |s: Option<String>| s.filter(|s| !s.is_empty());
    (pick(lines.next()), pick(lines.next()))
}

/// Total size of a folder, from the server's `du` (one round trip instead of a
/// walk over SFTP). In bytes; `du -sk` because busybox has no `-b`.
pub async fn dir_size(session: &Handle, path: &str) -> Result<u64, String> {
    let out = exec(session, &format!("du -sk -- {}", quote(path)), Duration::from_secs(60)).await?;
    let text = String::from_utf8_lossy(&out.stdout);
    let kib: u64 = text
        .split_whitespace()
        .next()
        .and_then(|n| n.parse().ok())
        .ok_or_else(|| stderr_or(&out, "du failed"))?;
    Ok(kib * 1024)
}

// ---------------------------------------------------------------------------
// Changes

/// A new empty file; fails if the name is taken.
pub async fn create_file(sftp: &SftpSession, path: &str) -> Result<(), String> {
    let file = sftp
        .open_with_flags(path, OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE)
        .await
        .map_err(err)?;
    file.close().await.map_err(|e| e.to_string())
}

pub async fn create_dir(sftp: &SftpSession, path: &str) -> Result<(), String> {
    if exists(sftp, path).await? {
        return Err("exists".to_string());
    }
    sftp.create_dir(path).await.map_err(err)
}

/// Renames or moves; never replaces an existing target.
pub async fn rename(sftp: &SftpSession, from: &str, to: &str) -> Result<(), String> {
    if exists(sftp, to).await? {
        return Err("exists".to_string());
    }
    sftp.rename(from, to).await.map_err(err)
}

pub async fn exists(sftp: &SftpSession, path: &str) -> Result<bool, String> {
    match sftp.symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(e) if is_missing(&e) => Ok(false),
        Err(e) => Err(err(e)),
    }
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Count {
    pub files: u64,
    pub dirs: u64,
    /// The walk stopped at `COUNT_LIMIT`.
    pub more: bool,
}

/// What deleting `paths` would remove. Symlinks count as files and are never
/// followed.
pub async fn count(sftp: &SftpSession, paths: &[String]) -> Result<Count, String> {
    let mut count = Count::default();
    let mut queue: VecDeque<String> = VecDeque::new();
    for path in paths {
        let attrs = sftp.symlink_metadata(path.as_str()).await.map_err(err)?;
        if attrs.is_dir() {
            count.dirs += 1;
            queue.push_back(path.clone());
        } else {
            count.files += 1;
        }
    }
    while let Some(dir) = queue.pop_front() {
        for item in sftp.read_dir(&dir).await.map_err(err)? {
            if count.files + count.dirs >= COUNT_LIMIT {
                count.more = true;
                return Ok(count);
            }
            if item.metadata().is_dir() && !item.metadata().is_symlink() {
                count.dirs += 1;
                queue.push_back(item.path());
            } else {
                count.files += 1;
            }
        }
    }
    Ok(count)
}

/// Deletes files and whole folders (depth first). Symlinks are removed, never
/// followed. Stops at the first error, which names the path.
pub async fn delete(sftp: &SftpSession, paths: &[String]) -> Result<(), String> {
    for path in paths {
        let attrs = sftp.symlink_metadata(path.as_str()).await.map_err(err)?;
        if attrs.is_dir() && !attrs.is_symlink() {
            delete_tree(sftp, path).await?;
        } else {
            sftp.remove_file(path.as_str()).await.map_err(|e| at(path, e))?;
        }
    }
    Ok(())
}

async fn delete_tree(sftp: &SftpSession, root: &str) -> Result<(), String> {
    // Iterative post-order: a deep tree must not grow the async stack.
    let mut stack = vec![(root.to_string(), false)];
    while let Some((dir, emptied)) = stack.pop() {
        if emptied {
            sftp.remove_dir(dir.as_str()).await.map_err(|e| at(&dir, e))?;
            continue;
        }
        // Checked again right before reading: a folder swapped for a symlink
        // since it was listed must not lead the walk somewhere else.
        let now = sftp.symlink_metadata(dir.as_str()).await.map_err(|e| at(&dir, e))?;
        if now.is_symlink() || !now.is_dir() {
            return Err(format!("{dir}: changed while deleting"));
        }
        stack.push((dir.clone(), true));
        for item in sftp.read_dir(&dir).await.map_err(|e| at(&dir, e))? {
            let meta = item.metadata();
            if meta.is_dir() && !meta.is_symlink() {
                stack.push((item.path(), false));
            } else {
                let path = item.path();
                sftp.remove_file(path.as_str()).await.map_err(|e| at(&path, e))?;
            }
        }
    }
    Ok(())
}

fn at(path: &str, e: SftpError) -> String {
    format!("{path}: {}", err(e))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteOutcome {
    /// Final paths of what was pasted.
    pub done: Vec<String>,
    /// Sources skipped because the name is taken in the destination.
    pub skipped: Vec<String>,
}

/// Pastes `sources` into `dest_dir`. Cut is an SFTP rename; copy is the
/// server's `cp -a` (SFTP has no copy). Pasting a copy into its own folder
/// makes "name (copy)"; any other name clash is skipped, never overwritten.
pub async fn paste(
    session: &Handle,
    sftp: &SftpSession,
    sources: &[String],
    dest_dir: &str,
    cut: bool,
) -> Result<PasteOutcome, String> {
    let mut outcome = PasteOutcome { done: Vec::new(), skipped: Vec::new() };
    for source in sources {
        let (parent, name) = split(source);
        let same_dir = parent.trim_end_matches('/') == dest_dir.trim_end_matches('/');
        let mut target = join(dest_dir, name);
        if cut && same_dir {
            continue;
        }
        if exists(sftp, &target).await? {
            if cut || !same_dir {
                outcome.skipped.push(source.clone());
                continue;
            }
            target = free_name(sftp, dest_dir, name).await?;
        }
        if cut {
            sftp.rename(source.as_str(), target.as_str()).await.map_err(|e| at(source, e))?;
        } else {
            // -n: a file that appeared there since the check is never replaced.
            let cmd = format!("cp -a -n -- {} {}", quote(source), quote(&target));
            let out = exec(session, &cmd, Duration::from_secs(600)).await?;
            if out.status != Some(0) {
                return Err(format!("{source}: {}", stderr_or(&out, "cp failed")));
            }
        }
        outcome.done.push(target);
    }
    Ok(outcome)
}

/// "name (copy).ext", "name (copy 2).ext"… whichever is free in `dir`.
async fn free_name(sftp: &SftpSession, dir: &str, name: &str) -> Result<String, String> {
    let (stem, ext) = stem_ext(name);
    for n in 1..1000 {
        let label = if n == 1 { "copy".to_string() } else { format!("copy {n}") };
        let candidate = join(dir, &format!("{stem} ({label}){ext}"));
        if !exists(sftp, &candidate).await? {
            return Ok(candidate);
        }
    }
    Err("exists".to_string())
}

/// Splits "a.tar.gz" as ("a.tar", ".gz"); dotfiles keep their name as the stem.
pub fn stem_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

// ---------------------------------------------------------------------------
// Viewing and editing

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Content {
    Text {
        text: String,
        size: u64,
        mtime: Option<u32>,
        /// Only the last `TAIL_BYTES` were read.
        tail: bool,
    },
    Binary { size: u64 },
    TooLarge { size: u64 },
}

/// A text file for the viewer/editor. `tail` reads only the last part of a
/// file over the limit (logs).
pub async fn read_text(sftp: &SftpSession, path: &str, tail: bool) -> Result<Content, String> {
    let attrs = sftp.metadata(path).await.map_err(err)?;
    let size = attrs.size.unwrap_or(0);
    if size > MAX_TEXT_BYTES && !tail {
        return Ok(Content::TooLarge { size });
    }
    let mut file = sftp.open(path).await.map_err(err)?;
    let from = if size > MAX_TEXT_BYTES { size - TAIL_BYTES } else { 0 };
    if from > 0 {
        file.seek(std::io::SeekFrom::Start(from)).await.map_err(|e| e.to_string())?;
    }
    let mut buf = Vec::with_capacity((size - from) as usize);
    (&mut file)
        .take(MAX_TEXT_BYTES)
        .read_to_end(&mut buf)
        .await
        .map_err(|e| e.to_string())?;
    let _ = file.close().await;
    if looks_binary(&buf) {
        return Ok(Content::Binary { size });
    }
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if from > 0 {
        // Starts mid-line: drop the partial first line.
        if let Some(i) = text.find('\n') {
            text.drain(..=i);
        }
    }
    Ok(Content::Text { text, size, mtime: attrs.mtime, tail: from > 0 })
}

/// NUL bytes, or mostly invalid UTF-8, in the first 8 KiB.
pub fn looks_binary(buf: &[u8]) -> bool {
    let head = &buf[..buf.len().min(8192)];
    if head.contains(&0) {
        return true;
    }
    let bad = String::from_utf8_lossy(head).matches('\u{FFFD}').count();
    bad * 20 > head.len().max(1)
}

/// Raw bytes of a small file (image preview).
pub async fn read_bytes(sftp: &SftpSession, path: &str) -> Result<Vec<u8>, String> {
    let attrs = sftp.metadata(path).await.map_err(err)?;
    if attrs.size.unwrap_or(0) > MAX_IMAGE_BYTES {
        return Err("too-large".to_string());
    }
    sftp.read(path).await.map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub size: u64,
    pub mtime: Option<u32>,
}

/// Saves edited text. Refuses with "conflict" when the file changed since it
/// was opened (size or mtime), unless `force`.
///
/// Safe write: a temp file next to the original, given the original's mode,
/// owner and group, then renamed over it (posix-rename) so a dropped
/// connection never leaves a half-written file. When that cannot keep the
/// file as it was (a symlink, an owner we can't set, no posix-rename) it
/// writes in place instead, which keeps inode, owner and links.
pub async fn write_text(
    sftp: &SftpSession,
    path: &str,
    text: &str,
    expect_size: u64,
    expect_mtime: Option<u32>,
    force: bool,
) -> Result<Saved, String> {
    let link = sftp.symlink_metadata(path).await.map_err(err)?;
    let current = sftp.metadata(path).await.map_err(err)?;
    if !force && (current.size.unwrap_or(0) != expect_size || current.mtime != expect_mtime) {
        return Err("conflict".to_string());
    }
    let data = text.as_bytes();
    let replaced = if link.is_symlink() {
        Staged::Unsuitable
    } else {
        replace_atomically(sftp, path, data, &current).await
    };
    if let Staged::Failed(e) = replaced {
        // The original is untouched; never fall back to truncating it after
        // a write that already failed once (a full disk would eat it).
        return Err(e);
    }
    if matches!(replaced, Staged::Unsuitable) {
        if !force && changed_since(sftp, path, expect_size, expect_mtime).await {
            return Err("conflict".to_string());
        }
        let mut file = sftp
            .open_with_flags(path, OpenFlags::WRITE | OpenFlags::TRUNCATE)
            .await
            .map_err(err)?;
        file.write_all(data).await.map_err(|e| e.to_string())?;
        file.shutdown().await.map_err(|e| e.to_string())?;
    }
    let after = sftp.metadata(path).await.map_err(err)?;
    Ok(Saved { size: after.size.unwrap_or(0), mtime: after.mtime })
}

enum Staged {
    Replaced,
    /// Can't keep the file as it was this way: write in place instead.
    Unsuitable,
    Failed(String),
}

async fn changed_since(sftp: &SftpSession, path: &str, size: u64, mtime: Option<u32>) -> bool {
    match sftp.metadata(path).await {
        Ok(now) => now.size.unwrap_or(0) != size || now.mtime != mtime,
        Err(_) => true,
    }
}

/// The temp-and-rename half of `write_text`; cleans up whatever it backs out of.
async fn replace_atomically(sftp: &SftpSession, path: &str, data: &[u8], original: &FileAttributes) -> Staged {
    let (dir, name) = split(path);
    let temp = join(dir, &format!(".{name}.protunel-{}", &Uuid::new_v4().simple().to_string()[..8]));
    let Ok(mut file) = sftp
        .open_with_flags(&temp, OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE)
        .await
    else {
        return Staged::Unsuitable; // no write access to the folder
    };
    let written = match file.write_all(data).await {
        Ok(()) => file.shutdown().await,
        Err(e) => Err(e),
    };
    drop(file);
    if let Err(e) = written {
        let _ = sftp.remove_file(&temp).await;
        return Staged::Failed(e.to_string());
    }
    let keep = FileAttributes {
        permissions: original.permissions.map(|p| p & 0o7777),
        uid: original.uid,
        gid: original.gid,
        ..FileAttributes::empty()
    };
    let _ = sftp.set_metadata(&temp, keep).await;
    let same = match sftp.metadata(&temp).await {
        Ok(t) => {
            t.uid == original.uid
                && t.gid == original.gid
                && t.permissions.map(|p| p & 0o7777) == original.permissions.map(|p| p & 0o7777)
        }
        Err(_) => false,
    };
    if !same {
        let _ = sftp.remove_file(&temp).await;
        return Staged::Unsuitable;
    }
    // Last look right before the swap (best effort: SFTP has no compare-and-swap).
    if changed_since(sftp, path, original.size.unwrap_or(0), original.mtime).await {
        let _ = sftp.remove_file(&temp).await;
        return Staged::Failed("conflict".to_string());
    }
    match sftp.posix_rename(&temp, path).await {
        Ok(true) => Staged::Replaced,
        Ok(false) => {
            let _ = sftp.remove_file(&temp).await;
            Staged::Unsuitable
        }
        Err(e) => {
            let _ = sftp.remove_file(&temp).await;
            Staged::Failed(err(e))
        }
    }
}

// ---------------------------------------------------------------------------
// Commands on the server (`cp -a`, `du`, `getent`)

pub struct ExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub status: Option<u32>,
}

/// Runs one command on the session (an `exec` channel, no PTY).
pub async fn exec(session: &Handle, command: &str, timeout: Duration) -> Result<ExecOutput, String> {
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("failed to open channel: {e}"))?;
    channel.exec(true, command).await.map_err(|e| e.to_string())?;
    let mut out = ExecOutput { stdout: Vec::new(), stderr: Vec::new(), status: None };
    let run = async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => out.stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => out.stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => out.status = Some(exit_status),
                _ => {}
            }
        }
    };
    if tokio::time::timeout(timeout, run).await.is_err() {
        let _ = channel.close().await;
        return Err("timeout".to_string());
    }
    Ok(out)
}

fn stderr_or(out: &ExecOutput, fallback: &str) -> String {
    let text = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if text.is_empty() {
        fallback.to_string()
    } else {
        text
    }
}

/// POSIX single-quoting: safe for any byte but NUL, in sh, bash, zsh and fish.
pub fn quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', r"'\''"))
}

// ---------------------------------------------------------------------------
// Transfers

#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Upload,
    Download,
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum TransferState {
    Queued,
    Running,
    Done,
    /// The target exists and overwriting was not asked for.
    Skipped,
    Failed,
    Cancelled,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: Uuid,
    pub tunnel_id: Uuid,
    pub direction: Direction,
    pub name: String,
    pub remote_path: String,
    pub local_path: String,
    pub done: u64,
    pub total: u64,
    pub state: TransferState,
    pub error: Option<String>,
    /// Open with the OS's app once downloaded ("Open with…" a temp copy).
    pub open_when_done: bool,
}

#[derive(Default)]
struct Transfers {
    list: Vec<Transfer>,
    cancels: HashMap<Uuid, CancellationToken>,
}

pub fn transfers(app: &AppHandle) -> Vec<Transfer> {
    app.state::<Files>().transfers.lock().unwrap().list.clone()
}

pub fn cancel(app: &AppHandle, id: Uuid) {
    if let Some(token) = app.state::<Files>().transfers.lock().unwrap().cancels.get(&id) {
        token.cancel();
    }
}

/// Drops finished transfers from the list.
pub fn clear_finished(app: &AppHandle) {
    let files = app.state::<Files>();
    let mut t = files.transfers.lock().unwrap();
    t.list.retain(|x| matches!(x.state, TransferState::Queued | TransferState::Running));
}

fn publish(app: &AppHandle, transfer: &Transfer) {
    let files = app.state::<Files>();
    {
        let mut t = files.transfers.lock().unwrap();
        match t.list.iter_mut().find(|x| x.id == transfer.id) {
            Some(slot) => *slot = transfer.clone(),
            None => t.list.push(transfer.clone()),
        }
        let finished = t
            .list
            .iter()
            .filter(|x| !matches!(x.state, TransferState::Queued | TransferState::Running))
            .count();
        if finished > KEEP_FINISHED {
            let mut drop = finished - KEEP_FINISHED;
            t.list.retain(|x| {
                let old = !matches!(x.state, TransferState::Queued | TransferState::Running);
                if old && drop > 0 {
                    drop -= 1;
                    false
                } else {
                    true
                }
            });
        }
    }
    let _ = app.emit(FILE_TRANSFER_EVENT, transfer);
}

pub struct UploadJob {
    pub local: PathBuf,
    pub remote_dir: String,
    pub overwrite: bool,
}

pub struct DownloadJob {
    pub remote: String,
    pub local_dir: PathBuf,
    pub open_when_done: bool,
}

/// Queues one transfer and returns its id; it runs when a slot frees up.
pub fn start_upload(app: &AppHandle, tunnel_id: Uuid, job: UploadJob) -> Uuid {
    let name = job
        .local
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let transfer = Transfer {
        id: Uuid::new_v4(),
        tunnel_id,
        direction: Direction::Upload,
        remote_path: join(&job.remote_dir, &name),
        local_path: job.local.to_string_lossy().into_owned(),
        name,
        done: 0,
        total: 0,
        state: TransferState::Queued,
        error: None,
        open_when_done: false,
    };
    spawn(app, transfer, move |ctx| Box::pin(upload(ctx, job)))
}

pub fn start_download(app: &AppHandle, tunnel_id: Uuid, job: DownloadJob) -> Uuid {
    let (_, name) = split(&job.remote);
    let transfer = Transfer {
        id: Uuid::new_v4(),
        tunnel_id,
        direction: Direction::Download,
        name: name.to_string(),
        remote_path: job.remote.clone(),
        local_path: job.local_dir.join(sanitize(name)).to_string_lossy().into_owned(),
        done: 0,
        total: 0,
        state: TransferState::Queued,
        error: None,
        open_when_done: job.open_when_done,
    };
    spawn(app, transfer, move |ctx| Box::pin(download(ctx, job)))
}

type JobFuture = std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>;

/// What a running job reports through.
struct Ctx {
    app: AppHandle,
    sftp: Arc<SftpSession>,
    transfer: Mutex<Transfer>,
    cancel: CancellationToken,
    last: Mutex<Instant>,
    skipped: AtomicBool,
    done: AtomicU64,
}

impl Ctx {
    fn set_total(&self, total: u64) {
        self.transfer.lock().unwrap().total = total;
    }
    fn set_local(&self, path: &Path) {
        self.transfer.lock().unwrap().local_path = path.to_string_lossy().into_owned();
    }
    fn advance(&self, bytes: u64) {
        let done = self.done.fetch_add(bytes, Ordering::Relaxed) + bytes;
        let mut last = self.last.lock().unwrap();
        if last.elapsed() >= PROGRESS_EVERY {
            *last = Instant::now();
            let snapshot = {
                let mut t = self.transfer.lock().unwrap();
                t.done = done;
                t.clone()
            };
            publish(&self.app, &snapshot);
        }
    }
    fn check(&self) -> Result<(), String> {
        if self.cancel.is_cancelled() {
            Err("cancelled".to_string())
        } else {
            Ok(())
        }
    }
}

fn spawn(
    app: &AppHandle,
    transfer: Transfer,
    run: impl FnOnce(Arc<Ctx>) -> JobFuture + Send + 'static,
) -> Uuid {
    let id = transfer.id;
    let cancel = CancellationToken::new();
    app.state::<Files>().transfers.lock().unwrap().cancels.insert(id, cancel.clone());
    publish(app, &transfer);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let slots = app.state::<Files>().slots.clone();
        let permit = tokio::select! {
            p = slots.acquire_owned() => p.ok(),
            _ = cancel.cancelled() => None,
        };
        let mut transfer = transfer;
        let result = match permit {
            None => Err("cancelled".to_string()),
            Some(_permit) => match sftp_for(&app, transfer.tunnel_id).await {
                Err(e) => Err(e),
                Ok(sftp) => {
                    transfer.state = TransferState::Running;
                    publish(&app, &transfer);
                    let ctx = Arc::new(Ctx {
                        app: app.clone(),
                        sftp,
                        transfer: Mutex::new(transfer.clone()),
                        cancel: cancel.clone(),
                        last: Mutex::new(Instant::now()),
                        skipped: AtomicBool::new(false),
                        done: AtomicU64::new(0),
                    });
                    let result = run(ctx.clone()).await;
                    transfer = ctx.transfer.lock().unwrap().clone();
                    transfer.done = ctx.done.load(Ordering::Relaxed);
                    if ctx.skipped.load(Ordering::Relaxed) && result.is_ok() {
                        transfer.state = TransferState::Skipped;
                    }
                    result
                }
            },
        };
        match result {
            Ok(()) if transfer.state == TransferState::Skipped => {}
            Ok(()) => {
                transfer.state = TransferState::Done;
                if transfer.open_when_done {
                    let opened = tauri_plugin_opener::open_path(&transfer.local_path, None::<&str>);
                    if let Err(e) = opened {
                        transfer.error = Some(e.to_string());
                    }
                }
            }
            Err(_) if cancel.is_cancelled() => transfer.state = TransferState::Cancelled,
            Err(e) => {
                transfer.state = TransferState::Failed;
                transfer.error = Some(e);
            }
        }
        if matches!(transfer.state, TransferState::Failed) {
            forget_if_dead(&app, transfer.tunnel_id).await;
        }
        app.state::<Files>().transfers.lock().unwrap().cancels.remove(&id);
        publish(&app, &transfer);
    });
    id
}

/// A failed transfer may have been the session dying; the next one reopens.
async fn forget_if_dead(app: &AppHandle, tunnel_id: Uuid) {
    let alive = app.state::<AppState>().session_for(tunnel_id).is_some_and(|s| !s.is_closed());
    if !alive {
        forget(app, tunnel_id).await;
    }
}

async fn upload(ctx: Arc<Ctx>, job: UploadJob) -> Result<(), String> {
    let name = job.local.file_name().ok_or("no file name")?.to_string_lossy().into_owned();
    let target = join(&job.remote_dir, &name);
    let meta = tokio::fs::metadata(&job.local).await.map_err(|e| e.to_string())?;
    if !job.overwrite && exists(&ctx.sftp, &target).await? {
        ctx.skipped.store(true, Ordering::Relaxed);
        return Ok(());
    }
    let result = if meta.is_dir() {
        ctx.set_total(local_size(&job.local).await);
        upload_tree(&ctx, &job.local, &target, job.overwrite).await
    } else {
        ctx.set_total(meta.len());
        upload_file(&ctx, &job.local, &target, job.overwrite).await
    };
    match result {
        // Someone else created the name meanwhile: still never replaced.
        Err(e) if e == "exists" => {
            ctx.skipped.store(true, Ordering::Relaxed);
            Ok(())
        }
        other => other,
    }
}

async fn local_size(root: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(mut rd) = tokio::fs::read_dir(&dir).await else { continue };
        while let Ok(Some(item)) = rd.next_entry().await {
            match item.file_type().await {
                Ok(t) if t.is_dir() => stack.push(item.path()),
                Ok(t) if t.is_file() => total += item.metadata().await.map(|m| m.len()).unwrap_or(0),
                _ => {}
            }
        }
    }
    total
}

async fn upload_tree(ctx: &Ctx, root: &Path, target: &str, overwrite: bool) -> Result<(), String> {
    let mut stack = vec![(root.to_path_buf(), target.to_string())];
    let mut first = true;
    while let Some((local, remote)) = stack.pop() {
        ctx.check()?;
        match ctx.sftp.symlink_metadata(remote.as_str()).await {
            // Merging (overwrite) only into a real folder, never through a link.
            Ok(a) if a.is_dir() && !a.is_symlink() && (overwrite || !first) => {}
            Ok(_) if first && !overwrite => return Err("exists".to_string()),
            Ok(_) => return Err(format!("{remote}: not a folder")),
            Err(e) if is_missing(&e) => {
                ctx.sftp.create_dir(remote.as_str()).await.map_err(|e| at(&remote, e))?;
            }
            Err(e) => return Err(at(&remote, e)),
        }
        first = false;
        let mut rd = tokio::fs::read_dir(&local).await.map_err(|e| e.to_string())?;
        while let Some(item) = rd.next_entry().await.map_err(|e| e.to_string())? {
            let name = item.file_name().to_string_lossy().into_owned();
            let child = join(&remote, &name);
            match item.file_type().await {
                Ok(t) if t.is_dir() => stack.push((item.path(), child)),
                Ok(t) if t.is_file() => upload_file(ctx, &item.path(), &child, overwrite).await?,
                _ => {} // symlinks and devices are not copied
            }
        }
    }
    Ok(())
}

/// Writes to `<name>.protunel-part` and renames when complete, so an
/// interrupted upload never looks like a finished file.
async fn upload_file(ctx: &Ctx, local: &Path, remote: &str, overwrite: bool) -> Result<(), String> {
    let mut src = tokio::fs::File::open(local).await.map_err(|e| e.to_string())?;
    // A part file of its own (never an existing file, never through a link).
    let part = format!("{remote}.{}.protunel-part", short_id());
    let mut dst = ctx
        .sftp
        .open_with_flags(part.as_str(), OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE)
        .await
        .map_err(|e| at(remote, e))?;
    let mut buf = vec![0u8; CHUNK];
    let copied: Result<(), String> = async {
        loop {
            ctx.check()?;
            let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
            ctx.advance(n as u64);
        }
        dst.shutdown().await.map_err(|e| e.to_string())
    }
    .await;
    if let Err(e) = copied {
        drop(dst);
        let _ = ctx.sftp.remove_file(part.as_str()).await;
        return Err(e);
    }
    drop(dst);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = tokio::fs::metadata(local).await {
            let attrs = FileAttributes {
                permissions: Some(meta.permissions().mode() & 0o777),
                ..FileAttributes::empty()
            };
            let _ = ctx.sftp.set_metadata(part.as_str(), attrs).await;
        }
    }
    let committed = commit_upload(ctx, &part, remote, overwrite).await;
    if committed.is_err() {
        let _ = ctx.sftp.remove_file(part.as_str()).await;
    }
    committed
}

/// Publishes a finished part file. Without `overwrite` a plain SFTP rename,
/// which refuses an existing name ("exists"); with it posix-rename, and only
/// when the server lacks that, remove-then-rename.
async fn commit_upload(ctx: &Ctx, part: &str, remote: &str, overwrite: bool) -> Result<(), String> {
    ctx.check()?; // a Cancel during the last write still wins
    if !overwrite {
        if exists(&ctx.sftp, remote).await? {
            return Err("exists".to_string());
        }
        return ctx.sftp.rename(part, remote).await.map_err(|e| {
            if matches!(&e, SftpError::Status(s) if s.status_code == StatusCode::Failure) {
                "exists".to_string()
            } else {
                at(remote, e)
            }
        });
    }
    match ctx.sftp.posix_rename(part, remote).await {
        Ok(true) => Ok(()),
        Ok(false) => {
            if exists(&ctx.sftp, remote).await? {
                ctx.sftp.remove_file(remote).await.map_err(|e| at(remote, e))?;
            }
            ctx.sftp.rename(part, remote).await.map_err(|e| at(remote, e))
        }
        Err(e) => Err(at(remote, e)),
    }
}

fn short_id() -> String {
    Uuid::new_v4().simple().to_string()[..8].to_string()
}

async fn download(ctx: Arc<Ctx>, job: DownloadJob) -> Result<(), String> {
    let attrs = ctx.sftp.metadata(job.remote.as_str()).await.map_err(err)?;
    let (_, name) = split(&job.remote);
    tokio::fs::create_dir_all(&job.local_dir).await.map_err(|e| e.to_string())?;
    // Downloads never overwrite a local file: "name (1).ext" like a browser,
    // the name reserved on disk so two downloads can't pick the same one.
    let local = reserve_local(&job.local_dir, name, attrs.is_dir()).await?;
    ctx.set_local(&local);
    let result = if attrs.is_dir() {
        let total = remote_size(ctx.as_ref(), &job.remote).await?;
        ctx.set_total(total);
        download_tree(&ctx, &job.remote, &local).await
    } else {
        ctx.set_total(attrs.size.unwrap_or(0));
        download_file(&ctx, &job.remote, &local).await
    };
    if result.is_err() && !attrs.is_dir() {
        let _ = tokio::fs::remove_file(&local).await; // the empty reservation
    }
    result
}

/// Creates `dir/name` (or "name (n).ext") exclusively and returns it: a file
/// as a placeholder the download then replaces, or the folder itself.
async fn reserve_local(dir: &Path, name: &str, folder: bool) -> Result<PathBuf, String> {
    let name = sanitize(name);
    let (stem, ext) = stem_ext(&name);
    for n in 0..10_000 {
        let path = if n == 0 { dir.join(&name) } else { dir.join(format!("{stem} ({n}){ext}")) };
        let made = if folder {
            tokio::fs::create_dir(&path).await.map(|_| ())
        } else {
            tokio::fs::OpenOptions::new().write(true).create_new(true).open(&path).await.map(|_| ())
        };
        match made {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("{}: {e}", path.display())),
        }
    }
    Err("exists".to_string())
}

async fn remote_size(ctx: &Ctx, root: &str) -> Result<u64, String> {
    let sftp = &ctx.sftp;
    let mut total = 0;
    let mut stack = vec![root.to_string()];
    while let Some(dir) = stack.pop() {
        ctx.check()?;
        let Ok(rd) = sftp.read_dir(&dir).await else { continue };
        for item in rd {
            let meta = item.metadata();
            if meta.is_dir() && !meta.is_symlink() {
                stack.push(item.path());
            } else if meta.is_regular() {
                total += meta.size.unwrap_or(0);
            }
        }
    }
    Ok(total)
}

async fn download_tree(ctx: &Ctx, root: &str, local_root: &Path) -> Result<(), String> {
    let mut stack = vec![(root.to_string(), local_root.to_path_buf())];
    while let Some((remote, local)) = stack.pop() {
        ctx.check()?;
        for item in ctx.sftp.read_dir(&remote).await.map_err(|e| at(&remote, e))? {
            let meta = item.metadata();
            // Names that differ remotely but not as local names (`a:b`, `a?b`)
            // get "(1)" instead of landing on each other.
            if meta.is_dir() && !meta.is_symlink() {
                let child = reserve_local(&local, &item.file_name(), true).await?;
                stack.push((item.path(), child));
            } else if meta.is_regular() {
                let child = reserve_local(&local, &item.file_name(), false).await?;
                download_file(ctx, &item.path(), &child).await?;
            }
        }
    }
    Ok(())
}

/// A remote name made safe as a local file name (Windows forbids `\:*?"<>|`).
pub fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    match cleaned.as_str() {
        "" | "." | ".." => "_".to_string(),
        _ => cleaned,
    }
}

async fn download_file(ctx: &Ctx, remote: &str, local: &Path) -> Result<(), String> {
    let mut src = ctx.sftp.open(remote).await.map_err(|e| at(remote, e))?;
    let part = local.with_file_name(format!(
        "{}.{}.protunel-part",
        local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        short_id()
    ));
    let mut dst = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&part)
        .await
        .map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; CHUNK];
    let copied: Result<(), String> = async {
        loop {
            ctx.check()?;
            let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
            ctx.advance(n as u64);
        }
        dst.flush().await.map_err(|e| e.to_string())
    }
    .await;
    drop(dst);
    let _ = src.close().await;
    // Replaces only this download's own placeholder (`reserve_local`).
    let committed = match copied {
        Ok(()) => ctx.check().and(tokio::fs::rename(&part, local).await.map_err(|e| e.to_string())),
        Err(e) => Err(e),
    };
    if committed.is_err() {
        let _ = tokio::fs::remove_file(&part).await;
    }
    committed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_split_and_join() {
        assert_eq!(split("/var/log/x.log"), ("/var/log", "x.log"));
        assert_eq!(split("/etc"), ("/", "etc"));
        assert_eq!(split("/etc/"), ("/", "etc"));
        assert_eq!(split("rel"), (".", "rel"));
        assert_eq!(join("/", "etc"), "/etc");
        assert_eq!(join("/var", "log"), "/var/log");
    }

    #[test]
    fn quoting_survives_any_name() {
        assert_eq!(quote("a b"), "'a b'");
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(quote("$(rm -rf /)"), "'$(rm -rf /)'");
        assert_eq!(quote("-rf"), "'-rf'");
    }

    #[test]
    fn copy_names_and_local_names() {
        assert_eq!(stem_ext("a.tar.gz"), ("a.tar", ".gz"));
        assert_eq!(stem_ext(".env"), (".env", ""));
        assert_eq!(stem_ext("Makefile"), ("Makefile", ""));
        assert_eq!(sanitize("a:b?.txt"), "a_b_.txt");
        assert_eq!(sanitize(".."), "_");
    }

    #[test]
    fn binary_detection() {
        assert!(!looks_binary(b"hello\nworld\n"));
        assert!(!looks_binary("xin chào".as_bytes()));
        assert!(looks_binary(b"\x7fELF\x02\x01\x01\x00\x00"));
        assert!(looks_binary(&[0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa]));
    }

    #[tokio::test]
    async fn local_names_are_reserved_never_clobbered() {
        let dir = std::env::temp_dir().join(format!("protunel-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(reserve_local(&dir, "a.txt", false).await.unwrap(), dir.join("a.txt"));
        assert_eq!(reserve_local(&dir, "a.txt", false).await.unwrap(), dir.join("a (1).txt"));
        assert_eq!(reserve_local(&dir, "a:b", false).await.unwrap(), dir.join("a_b"));
        assert_eq!(reserve_local(&dir, "a?b", false).await.unwrap(), dir.join("a_b (1)"));
        assert_eq!(reserve_local(&dir, "../x", true).await.unwrap(), dir.join(".._x"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
