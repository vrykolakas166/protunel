//! SFTP over a tunnel's live session: the file popup's backend.
//!
//! Like a terminal, this never owns a connection. An `sftp` subsystem channel
//! is opened on the tunnel's authenticated `client::Handle` and cached per
//! tunnel; the cache entry is only reused while it belongs to that same session
//! (the supervisor replaces the handle on every reconnect), so an operation can
//! never land on a stale session.
//!
//! Transfers run over SSH or through Rust. The webview sees directory listings
//! and the contents it opens to view or edit (bounded by the preview limits).

mod helpers;
mod listing;
mod operations;
mod preview;
mod transfers;

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use russh::{client, ChannelMsg};
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::ssh::SshHandler;
use crate::AppState;

#[path = "../copy_across.rs"]
mod copy_across;

pub use copy_across::{copy_across, CopyAcross};
pub use helpers::{join, quote, sanitize, split, stem_ext};
pub use listing::{dir_size, list, properties, Listing, Properties};
pub use operations::{count, create_dir, create_file, delete, exists, paste, rename, Count, PasteOutcome};
pub use preview::{read_bytes, read_text, write_text, Content, Expect, Saved};

pub use transfers::{
    cancel, claim_retry, clear_finished, settle_retry, start_download, start_upload, transfers, Conflict, Direction, DownloadJob,
    JobMeta, Placed, Route, Transfer, TransferState, UploadJob,
};

use operations::delete_tree;
use transfers::{already_done, commit_part, free_remote, short_id, spawn, Ctx, Transfers, Write, PARALLEL_TRANSFERS};

pub(super) use transfers::publish;
#[cfg(windows)]
pub(super) use transfers::{finish_drag_out, track_drag_out};

/// Progress events per transfer, at most.
pub(super) const PROGRESS_EVERY: Duration = Duration::from_millis(200);
pub(super) const CHUNK: usize = 256 * 1024;

type Handle = client::Handle<SshHandler>;

struct Cached {
    session: Weak<Handle>,
    sftp: Arc<SftpSession>,
    /// When it was opened: an error from an older call never evicts it.
    opened: Instant,
}

/// The endpoint (`user@host:port`) a session was authenticated to.
struct Endpoint {
    session: Weak<Handle>,
    target: String,
}

/// Open SFTP channels and the transfer queue. Managed state.
pub struct Files {
    cache: tokio::sync::Mutex<HashMap<Uuid, Cached>>,
    /// One channel opening per tunnel at a time (two panels' first calls
    /// share one channel instead of opening two).
    opening: Mutex<HashMap<Uuid, Arc<tokio::sync::Mutex<()>>>>,
    endpoints: Mutex<Vec<Endpoint>>,
    copy_probes: copy_across::Probes,
    transfers: Mutex<Transfers>,
    slots: Arc<Semaphore>,
}

impl Default for Files {
    fn default() -> Self {
        Self {
            cache: tokio::sync::Mutex::new(HashMap::new()),
            opening: Mutex::new(HashMap::new()),
            endpoints: Mutex::new(Vec::new()),
            copy_probes: copy_across::Probes::default(),
            transfers: Mutex::new(Transfers::default()),
            slots: Arc::new(Semaphore::new(PARALLEL_TRANSFERS)),
        }
    }
}

/// Records which endpoint a freshly authenticated session reached (the
/// supervisor calls this on every connect). The `Weak` keeps the allocation,
/// so a later session can never be mistaken for this one.
pub fn note_session(app: &AppHandle, session: &Arc<Handle>, target: String) {
    let files = app.state::<Files>();
    let mut endpoints = files.endpoints.lock().unwrap();
    endpoints.retain(|e| e.session.strong_count() > 0);
    endpoints.push(Endpoint { session: Arc::downgrade(session), target });
}

/// Refuses a session that reaches another endpoint than `target`, the one the
/// panel shows: after a tunnel's host is edited and it reconnects, a panel
/// still naming the old server must not write to the new one.
fn check_target(app: &AppHandle, session: &Arc<Handle>, target: &str) -> Result<(), String> {
    let files = app.state::<Files>();
    let endpoints = files.endpoints.lock().unwrap();
    match endpoints.iter().find(|e| e.session.upgrade().is_some_and(|s| Arc::ptr_eq(&s, session))) {
        Some(e) if e.target != target => Err("target-changed".to_string()),
        _ => Ok(()),
    }
}

/// The SFTP channel of a tunnel's current session, opened on first use.
pub async fn sftp_for(app: &AppHandle, tunnel_id: Uuid) -> Result<Arc<SftpSession>, String> {
    let state = app.state::<AppState>();
    let session = state.session_for(tunnel_id).ok_or("not-connected")?;
    sftp_for_session(app, tunnel_id, &session).await
}

/// `sftp_for`, only when the session still reaches `target` (`check_target`).
pub async fn sftp_checked(app: &AppHandle, tunnel_id: Uuid, target: &str) -> Result<Arc<SftpSession>, String> {
    let state = app.state::<AppState>();
    let session = state.session_for(tunnel_id).ok_or("not-connected")?;
    check_target(app, &session, target)?;
    sftp_for_session(app, tunnel_id, &session).await
}

/// The endpoint the tunnel's current session reached, if connected: what a
/// queued job binds to so it never runs against a server edited in later.
pub fn endpoint_now(app: &AppHandle, tunnel_id: Uuid) -> Option<String> {
    let session = app.state::<AppState>().session_for(tunnel_id)?;
    let files = app.state::<Files>();
    let endpoints = files.endpoints.lock().unwrap();
    endpoints
        .iter()
        .find(|e| e.session.upgrade().is_some_and(|s| Arc::ptr_eq(&s, &session)))
        .map(|e| e.target.clone())
}

/// A name a server listed is one path component: a broken or hostile
/// server's "../x" or "a/b" must never send a walk (delete, count,
/// download, listing) outside the folder it is in.
pub(crate) fn valid_name(name: &str) -> bool {
    !matches!(name, "" | "." | "..") && !name.contains(['/', '\0'])
}

/// Creates a new file (never an existing one) readable by its owner only:
/// a temp that will hold another file's bytes must not be world-readable
/// while it fills, whatever the server's umask. The caller gives it its
/// final mode before publishing it.
pub(super) async fn create_private(sftp: &SftpSession, path: &str) -> Result<russh_sftp::client::fs::File, russh_sftp::client::error::Error> {
    sftp.open_with_flags_and_attributes(
        path,
        OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
        FileAttributes { permissions: Some(0o600), ..FileAttributes::empty() },
    )
    .await
}

/// The tunnel's current session, checked against `expect` when given, and
/// its SFTP channel: one session for both, so a reconnect in between can
/// never send part of the work to another server.
pub async fn bound_session(app: &AppHandle, tunnel_id: Uuid, expect: Option<&str>) -> Result<(Arc<Handle>, Arc<SftpSession>), String> {
    let session = app.state::<AppState>().session_for(tunnel_id).ok_or("not-connected")?;
    if let Some(target) = expect {
        check_target(app, &session, target)?;
    }
    let sftp = sftp_for_session(app, tunnel_id, &session).await?;
    Ok((session, sftp))
}

/// Drops `sftp` from the cache if it is still the cached channel (one that
/// failed); a newer one opened meanwhile stays.
pub async fn forget_channel(app: &AppHandle, tunnel_id: Uuid, sftp: &Arc<SftpSession>) {
    let files = app.state::<Files>();
    let mut cache = files.cache.lock().await;
    if cache.get(&tunnel_id).is_some_and(|entry| Arc::ptr_eq(&entry.sftp, sftp)) {
        cache.remove(&tunnel_id);
    }
}

/// `sftp_checked` when the job was bound to an endpoint, else `sftp_for`.
pub async fn sftp_bound(app: &AppHandle, tunnel_id: Uuid, expect: Option<&str>) -> Result<Arc<SftpSession>, String> {
    match expect {
        Some(target) => sftp_checked(app, tunnel_id, target).await,
        None => sftp_for(app, tunnel_id).await,
    }
}

async fn cached(files: &Files, tunnel_id: Uuid, session: &Arc<Handle>) -> Option<Arc<SftpSession>> {
    let cache = files.cache.lock().await;
    cache
        .get(&tunnel_id)
        .filter(|entry| entry.session.upgrade().is_some_and(|s| Arc::ptr_eq(&s, session)))
        .map(|entry| entry.sftp.clone())
}

async fn sftp_for_session(app: &AppHandle, tunnel_id: Uuid, session: &Arc<Handle>) -> Result<Arc<SftpSession>, String> {
    let files = app.state::<Files>();
    if let Some(sftp) = cached(&files, tunnel_id, session).await {
        return Ok(sftp);
    }
    // One opener per tunnel; other tunnels never wait on a slow server.
    let gate = files.opening.lock().unwrap().entry(tunnel_id).or_default().clone();
    let _opening = gate.lock().await;
    if let Some(sftp) = cached(&files, tunnel_id, session).await {
        return Ok(sftp);
    }
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
        Cached { session: Arc::downgrade(session), sftp: sftp.clone(), opened: Instant::now() },
    );
    Ok(sftp)
}

/// Drops a tunnel's cached channel after an error that may mean it is dead,
/// so the next call opens a fresh one. `since`: when the failed call started;
/// a channel opened after that (another panel's, or a reconnect's) is kept.
pub async fn forget(app: &AppHandle, tunnel_id: Uuid, since: Instant) {
    let files = app.state::<Files>();
    let mut cache = files.cache.lock().await;
    if cache.get(&tunnel_id).is_some_and(|entry| entry.opened <= since) {
        cache.remove(&tunnel_id);
    }
}

/// Error text for the webview. Codes the UI translates are bare words.
pub fn err(e: SftpError) -> String {
    match e {
        SftpError::Status(s) => match s.status_code {
            StatusCode::NoSuchFile => "no-such-file".to_string(),
            StatusCode::PermissionDenied => "permission-denied".to_string(),
            StatusCode::ConnectionLost | StatusCode::NoConnection => "connection-lost".to_string(),
            _ if s.error_message.is_empty() => s.status_code.to_string(),
            _ => s.error_message,
        },
        SftpError::Timeout => "timeout".to_string(),
        // The channel itself is gone: every later call fails the same way.
        SftpError::IO(_) | SftpError::UnexpectedPacket | SftpError::UnexpectedBehavior(_) => "connection-lost".to_string(),
        other => other.to_string(),
    }
}

/// An I/O error on an open server file: a dropped channel reads as
/// "connection-lost" (see `err`), anything else as itself.
pub fn remote_io(e: std::io::Error) -> String {
    use std::io::ErrorKind::*;
    // russh-sftp wraps its own errors (a dead channel among them) as Other.
    if let Some(inner) = e.get_ref().and_then(|i| i.downcast_ref::<SftpError>()) {
        return err(inner.clone());
    }
    if e.to_string() == "unexpected response packet" {
        return "connection-lost".to_string();
    }
    match e.kind() {
        BrokenPipe | ConnectionReset | ConnectionAborted | NotConnected | UnexpectedEof => "connection-lost".to_string(),
        TimedOut => "timeout".to_string(),
        _ => e.to_string(),
    }
}

fn is_missing(e: &SftpError) -> bool {
    matches!(e, SftpError::Status(s) if s.status_code == StatusCode::NoSuchFile)
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

fn at(path: &str, e: SftpError) -> String {
    format!("{path}: {}", err(e))
}
