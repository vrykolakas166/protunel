use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
#[cfg(unix)]
use russh_sftp::protocol::FileAttributes;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::events::FILE_TRANSFER_EVENT;
use crate::AppState;

use super::{at, endpoint_now, err, exists, forget, is_missing, join, sanitize, sftp_bound, split, stem_ext, Files, CHUNK, PROGRESS_EVERY};

/// Transfers running at once, over every host.
pub(super) const PARALLEL_TRANSFERS: usize = 3;
/// Finished transfers kept for a reloaded webview.
const KEEP_FINISHED: usize = 50;

#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Upload,
    Download,
    Copy,
    #[cfg_attr(not(windows), allow(dead_code))]
    DragOut,
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Route {
    Rsync,
    Scp,
    Relay,
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
    /// Copy only: B. The source on A is `remote_path`, and `local_path` is the folder on B.
    pub dest_tunnel_id: Option<Uuid>,
    pub route: Option<Route>,
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
pub(super) struct Transfers {
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
/// Drops finished rows: every one, or only those touching `tunnel` (a file
/// panel clears its own server's rows, never another panel's).
pub fn clear_finished(app: &AppHandle, tunnel: Option<Uuid>) {
    let files = app.state::<Files>();
    let mut t = files.transfers.lock().unwrap();
    t.list.retain(|x| {
        matches!(x.state, TransferState::Queued | TransferState::Running)
            || tunnel.is_some_and(|id| x.tunnel_id != id && x.dest_tunnel_id != Some(id))
    });
}

pub(in crate::ssh) fn publish(app: &AppHandle, transfer: &Transfer) {
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

/// Attach an externally driven stream to the normal transfer queue.
#[cfg(windows)]
pub(in crate::ssh) fn track_drag_out(app: &AppHandle, transfer: &Transfer, cancel: &CancellationToken) {
    app.state::<Files>().transfers.lock().unwrap().cancels.insert(transfer.id, cancel.clone());
    publish(app, transfer);
}

#[cfg(windows)]
pub(in crate::ssh) fn finish_drag_out(app: &AppHandle, transfer: &Transfer) {
    app.state::<Files>().transfers.lock().unwrap().cancels.remove(&transfer.id);
    publish(app, transfer);
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

/// What a queued job may run against: the endpoint the tunnel reached when the
/// job was queued (see `endpoint_now`).
pub fn bind(app: &AppHandle, tunnel_id: Uuid) -> Option<String> {
    endpoint_now(app, tunnel_id)
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
        dest_tunnel_id: None,
        route: None,
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
    let expect = bind(app, tunnel_id);
    spawn(app, transfer, move |ctx| Box::pin(upload(ctx, tunnel_id, expect, job)))
}

pub fn start_download(app: &AppHandle, tunnel_id: Uuid, job: DownloadJob) -> Uuid {
    let (_, name) = split(&job.remote);
    let transfer = Transfer {
        id: Uuid::new_v4(),
        tunnel_id,
        dest_tunnel_id: None,
        route: None,
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
    let expect = bind(app, tunnel_id);
    spawn(app, transfer, move |ctx| Box::pin(download(ctx, tunnel_id, expect, job)))
}

type JobFuture = std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>;

/// What a running job reports through.
pub(super) struct Ctx {
    pub(super) app: AppHandle,
    pub(super) transfer: Mutex<Transfer>,
    pub(super) cancel: CancellationToken,
    last: Mutex<Instant>,
    pub(super) skipped: AtomicBool,
    pub(super) done: AtomicU64,
}

impl Ctx {
    pub(super) fn set_total(&self, total: u64) {
        self.transfer.lock().unwrap().total = total;
    }
    fn set_local(&self, path: &Path) {
        self.transfer.lock().unwrap().local_path = path.to_string_lossy().into_owned();
    }
    pub(super) fn advance(&self, bytes: u64) {
        let done = self.done.fetch_add(bytes, Ordering::Relaxed) + bytes;
        self.publish_progress(done);
    }
    pub(super) fn publish_progress(&self, done: u64) {
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
    pub(super) fn check(&self) -> Result<(), String> {
        if self.cancel.is_cancelled() {
            Err("cancelled".to_string())
        } else {
            Ok(())
        }
    }
}

pub(super) fn spawn(
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
            biased;
            _ = cancel.cancelled() => None,
            p = slots.acquire_owned() => p.ok(),
        };
        let mut transfer = transfer;
        let mut started = Instant::now();
        let result = match permit {
            None => Err("cancelled".to_string()),
            Some(_permit) => {
                started = Instant::now();
                transfer.state = TransferState::Running;
                publish(&app, &transfer);
                let ctx = Arc::new(Ctx {
                    app: app.clone(),
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
            Err(e) if cancel.is_cancelled() => {
                transfer.state = TransferState::Cancelled;
                if transfer.direction == Direction::Copy && e != "cancelled" {
                    transfer.error = Some(e);
                }
            }
            Err(e) => {
                transfer.state = TransferState::Failed;
                transfer.error = Some(e);
            }
        }
        if matches!(transfer.state, TransferState::Failed) {
            forget_if_dead(&app, transfer.tunnel_id, started).await;
            if let Some(dest_tunnel_id) = transfer.dest_tunnel_id {
                forget_if_dead(&app, dest_tunnel_id, started).await;
            }
        }
        app.state::<Files>().transfers.lock().unwrap().cancels.remove(&id);
        publish(&app, &transfer);
    });
    id
}

/// A failed transfer may have been the session dying; the next one reopens.
async fn forget_if_dead(app: &AppHandle, tunnel_id: Uuid, started: Instant) {
    let alive = app.state::<AppState>().session_for(tunnel_id).is_some_and(|s| !s.is_closed());
    if !alive {
        forget(app, tunnel_id, started).await;
    }
}

async fn upload(ctx: Arc<Ctx>, tunnel_id: Uuid, expect: Option<String>, job: UploadJob) -> Result<(), String> {
    let sftp = sftp_bound(&ctx.app, tunnel_id, expect.as_deref()).await?;
    let name = job.local.file_name().ok_or("no file name")?.to_string_lossy().into_owned();
    let target = join(&job.remote_dir, &name);
    let meta = tokio::fs::metadata(&job.local).await.map_err(|e| e.to_string())?;
    if !job.overwrite && exists(&sftp, &target).await? {
        ctx.skipped.store(true, Ordering::Relaxed);
        return Ok(());
    }
    let result = if meta.is_dir() {
        ctx.set_total(local_size(&job.local).await);
        upload_tree(&ctx, &sftp, &job.local, &target, job.overwrite).await
    } else {
        ctx.set_total(meta.len());
        upload_file(&ctx, &sftp, &job.local, &target, job.overwrite).await
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

async fn upload_tree(ctx: &Ctx, sftp: &SftpSession, root: &Path, target: &str, overwrite: bool) -> Result<(), String> {
    let mut stack = vec![(root.to_path_buf(), target.to_string())];
    let mut first = true;
    while let Some((local, remote)) = stack.pop() {
        ctx.check()?;
        match sftp.symlink_metadata(remote.as_str()).await {
            // Merging (overwrite) only into a real folder, never through a link.
            Ok(a) if a.is_dir() && !a.is_symlink() && (overwrite || !first) => {}
            Ok(_) if first && !overwrite => return Err("exists".to_string()),
            Ok(_) => return Err(format!("{remote}: not a folder")),
            Err(e) if is_missing(&e) => {
                sftp.create_dir(remote.as_str()).await.map_err(|e| at(&remote, e))?;
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
                Ok(t) if t.is_file() => upload_file(ctx, sftp, &item.path(), &child, overwrite).await?,
                _ => {} // symlinks and devices are not copied
            }
        }
    }
    Ok(())
}

/// Writes to `<name>.protunel-part` and renames when complete, so an
/// interrupted upload never looks like a finished file.
async fn upload_file(ctx: &Ctx, sftp: &SftpSession, local: &Path, remote: &str, overwrite: bool) -> Result<(), String> {
    let mut src = tokio::fs::File::open(local).await.map_err(|e| e.to_string())?;
    // A part file of its own (never an existing file, never through a link).
    let part = format!("{remote}.{}.protunel-part", short_id());
    let mut dst = sftp
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
        let _ = sftp.remove_file(part.as_str()).await;
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
            let _ = sftp.set_metadata(part.as_str(), attrs).await;
        }
    }
    let committed = commit_part(ctx, sftp, &part, remote, overwrite).await;
    if committed.is_err() {
        let _ = sftp.remove_file(part.as_str()).await;
    }
    committed
}

/// Publishes a finished part file. Without `overwrite` a plain SFTP rename,
/// which refuses an existing name ("exists"); with it posix-rename, and only
/// when the server lacks that, a recoverable swap: the old file is renamed
/// aside first and renamed back if the new one can't take its place, so a
/// dropped connection never leaves the name missing with nothing to restore.
pub(super) async fn commit_part(ctx: &Ctx, sftp: &SftpSession, part: &str, remote: &str, overwrite: bool) -> Result<(), String> {
    ctx.check()?; // a Cancel during the last write still wins
    if !overwrite {
        if exists(sftp, remote).await? {
            return Err("exists".to_string());
        }
        return match sftp.rename(part, remote).await {
            Ok(()) => Ok(()),
            Err(e) if matches!(&e, SftpError::Status(_)) && exists(sftp, remote).await? => {
                Err("exists".to_string())
            }
            Err(e) => Err(at(remote, e)),
        };
    }
    match sftp.posix_rename(part, remote).await {
        Ok(true) => Ok(()),
        Ok(false) => {
            let old = match sftp.symlink_metadata(remote).await {
                Err(e) if is_missing(&e) => None,
                Err(e) => return Err(at(remote, e)),
                Ok(a) if a.is_dir() => return Err(format!("{remote}: not a file")),
                Ok(_) => {
                    let (dir, name) = split(remote);
                    let aside = join(dir, &format!(".{name}.{}.protunel-old", short_id()));
                    sftp.rename(remote, aside.as_str()).await.map_err(|e| at(remote, e))?;
                    Some(aside)
                }
            };
            match sftp.rename(part, remote).await {
                Ok(()) => {
                    if let Some(aside) = old {
                        let _ = sftp.remove_file(aside.as_str()).await;
                    }
                    Ok(())
                }
                Err(e) => {
                    if let Some(aside) = old {
                        let _ = sftp.rename(aside.as_str(), remote).await;
                    }
                    Err(at(remote, e))
                }
            }
        }
        Err(e) => Err(at(remote, e)),
    }
}

pub(super) fn short_id() -> String {
    Uuid::new_v4().simple().to_string()[..8].to_string()
}

async fn download(ctx: Arc<Ctx>, tunnel_id: Uuid, expect: Option<String>, job: DownloadJob) -> Result<(), String> {
    let sftp = sftp_bound(&ctx.app, tunnel_id, expect.as_deref()).await?;
    let attrs = sftp.metadata(job.remote.as_str()).await.map_err(err)?;
    let (_, name) = split(&job.remote);
    tokio::fs::create_dir_all(&job.local_dir).await.map_err(|e| e.to_string())?;
    // Downloads never overwrite a local file: "name (1).ext" like a browser.
    // A folder is reserved up front (created by us, so ours); a file is
    // written to a private part file and only then published under the
    // first free name (`publish_local`), so nothing placed under the final
    // name meanwhile is ever replaced or deleted.
    if attrs.is_dir() {
        let local = reserve_dir(&job.local_dir, name).await?;
        ctx.set_local(&local);
        let total = remote_size(&ctx, &sftp, &job.remote).await?;
        ctx.set_total(total);
        download_tree(&ctx, &sftp, &job.remote, &local).await
    } else {
        ctx.set_total(attrs.size.unwrap_or(0));
        let local = download_file(&ctx, &sftp, &job.remote, &job.local_dir, name).await?;
        ctx.set_local(&local);
        Ok(())
    }
}

fn candidate(dir: &Path, name: &str, n: u32) -> PathBuf {
    let (stem, ext) = stem_ext(name);
    if n == 0 {
        dir.join(name)
    } else {
        dir.join(format!("{stem} ({n}){ext}"))
    }
}

/// Creates the folder `dir/name` (or "name (n)") exclusively and returns it.
async fn reserve_dir(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let name = sanitize(name);
    for n in 0..10_000 {
        let path = candidate(dir, &name, n);
        match tokio::fs::create_dir(&path).await {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("{}: {e}", path.display())),
        }
    }
    Err("exists".to_string())
}

pub(super) async fn remote_size(ctx: &Ctx, sftp: &SftpSession, root: &str) -> Result<u64, String> {
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

async fn download_tree(ctx: &Ctx, sftp: &SftpSession, root: &str, local_root: &Path) -> Result<(), String> {
    let mut stack = vec![(root.to_string(), local_root.to_path_buf())];
    while let Some((remote, local)) = stack.pop() {
        ctx.check()?;
        for item in sftp.read_dir(&remote).await.map_err(|e| at(&remote, e))? {
            let meta = item.metadata();
            // Names that differ remotely but not as local names (`a:b`, `a?b`)
            // get "(1)" instead of landing on each other.
            if meta.is_dir() && !meta.is_symlink() {
                let child = reserve_dir(&local, &item.file_name()).await?;
                stack.push((item.path(), child));
            } else if meta.is_regular() {
                download_file(ctx, sftp, &item.path(), &local, &item.file_name()).await?;
            }
        }
    }
    Ok(())
}

/// Downloads `remote` into `dir` under `name` (or the first free "name (n)")
/// and returns where it landed.
async fn download_file(ctx: &Ctx, sftp: &SftpSession, remote: &str, dir: &Path, name: &str) -> Result<PathBuf, String> {
    let name = sanitize(name);
    let mut src = sftp.open(remote).await.map_err(|e| at(remote, e))?;
    let part = dir.join(format!(".{name}.{}.protunel-part", short_id()));
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
    // A Cancel during the last write still wins: checked before publishing.
    let committed = match copied.and_then(|()| ctx.check()) {
        Ok(()) => publish_local(&part, dir, &name).await,
        Err(e) => Err(e),
    };
    let _ = tokio::fs::remove_file(&part).await;
    committed
}

/// Gives a finished part file its final name without ever replacing a file:
/// a hard link fails when the name exists (atomic no-replace on every OS), so
/// the next "name (n)" is tried. Where hard links are unsupported (FAT,
/// some network shares) the name is created exclusively and the part file
/// copied into it.
async fn publish_local(part: &Path, dir: &Path, name: &str) -> Result<PathBuf, String> {
    for n in 0..10_000 {
        let path = candidate(dir, name, n);
        match tokio::fs::hard_link(part, &path).await {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return publish_by_copy(part, dir, name, n).await,
        }
    }
    Err("exists".to_string())
}

async fn publish_by_copy(part: &Path, dir: &Path, name: &str, from: u32) -> Result<PathBuf, String> {
    for n in from..10_000 {
        let path = candidate(dir, name, n);
        let mut dst = match tokio::fs::OpenOptions::new().write(true).create_new(true).open(&path).await {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        let copied = async {
            let mut src = tokio::fs::File::open(part).await?;
            tokio::io::copy(&mut src, &mut dst).await?;
            dst.flush().await
        }
        .await;
        return match copied {
            Ok(()) => Ok(path),
            Err(e) => {
                drop(dst);
                let _ = tokio::fs::remove_file(&path).await; // ours: created exclusively above
                Err(e.to_string())
            }
        };
    }
    Err("exists".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_names_are_reserved_never_clobbered() {
        let dir = std::env::temp_dir().join(format!("protunel-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(reserve_dir(&dir, "a").await.unwrap(), dir.join("a"));
        assert_eq!(reserve_dir(&dir, "a").await.unwrap(), dir.join("a (1)"));
        assert_eq!(reserve_dir(&dir, "a:b").await.unwrap(), dir.join("a_b"));
        assert_eq!(reserve_dir(&dir, "a?b").await.unwrap(), dir.join("a_b (1)"));
        assert_eq!(reserve_dir(&dir, "../x").await.unwrap(), dir.join(".._x"));
        // Files: published next to (never over) what is there.
        std::fs::write(dir.join("f.txt"), b"theirs").unwrap();
        let part = dir.join("part");
        std::fs::write(&part, b"ours").unwrap();
        assert_eq!(publish_local(&part, &dir, "f.txt").await.unwrap(), dir.join("f (1).txt"));
        assert_eq!(std::fs::read(dir.join("f.txt")).unwrap(), b"theirs");
        assert_eq!(std::fs::read(dir.join("f (1).txt")).unwrap(), b"ours");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
