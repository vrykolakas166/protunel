use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileAttributes;
use super::create_private;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::events::{FILE_TRANSFER_EVENT, FILE_TRANSFER_REMOVED_EVENT};
use crate::AppState;

use super::{at, endpoint_now, err, exists, remote_io, forget, is_missing, join, sanitize, sftp_bound, split, stem_ext, Files, CHUNK, PROGRESS_EVERY};

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

/// What an upload or copy does when its name is already taken.
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Conflict {
    /// Leave what is there; the transfer ends as Skipped.
    Skip,
    /// Replace it (a folder is merged, its files replaced).
    Replace,
    /// Use the first free "name (n).ext" instead.
    KeepBoth,
    /// Retry of a partial transfer: merge into the folder, skip every file
    /// already there (a file only ever gets its final name once complete).
    Resume,
}

/// Failed files listed on a partial transfer, at most.
const MAX_FAILURES: usize = 20;

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
    /// Files finished, in a folder transfer (a file transfer counts 1).
    pub files_done: u32,
    /// Files that failed while the rest went on (error "partial").
    pub files_failed: u32,
    /// The first failures, "path: error".
    pub failures: Vec<String>,
    /// The server (`user@host:port`) the job runs against, as when it was
    /// queued: the row keeps naming it after the host is edited.
    pub endpoint: Option<String>,
    /// A copy's B.
    pub dest_endpoint: Option<String>,
}

/// What a job finished, so its retry redoes only the rest: for an upload or
/// copy the target paths it gave their final name, for a download each
/// remote path and the local path it landed on (folders included, so a
/// retry continues in folders the job made itself, never in a lookalike).
pub type Placed = HashMap<String, String>;

/// What a retry needs to know about a job beyond its row; never sent to the
/// webview.
#[derive(Clone, Default)]
pub struct JobMeta {
    /// Upload/copy: the conflict choice the job was started with.
    pub conflict: Option<Conflict>,
    /// The endpoint the job ran (or was bound to run) against; a copy's A.
    pub endpoint: Option<String>,
    /// A copy's B.
    pub dest_endpoint: Option<String>,
    pub placed: Placed,
    /// The job made its target itself (a new name, or a "keep both" one):
    /// a retry may merge into it keeping what is there.
    pub owns: bool,
}

#[derive(Default)]
pub(super) struct Transfers {
    list: Vec<Transfer>,
    cancels: HashMap<Uuid, CancellationToken>,
    jobs: HashMap<Uuid, JobMeta>,
    /// Rows a retry is starting from: left listed until the new job is
    /// queued, so a refused retry keeps its row (and what it finished).
    claimed: HashSet<Uuid>,
    /// Names a running job picked with `free_remote` ("tunnel path"), so
    /// two "keep both" jobs never pick the same one.
    reserved: HashSet<String>,
}

impl Transfers {
    /// Keeps `jobs` to the rows still listed.
    fn prune(&mut self) {
        let list = &self.list;
        self.jobs.retain(|id, _| list.iter().any(|x| x.id == *id));
    }
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
    t.prune();
}

/// Takes a row off the list to run it again, with what the job recorded: a
/// failed or cancelled one (a retry), or a skipped one (`skipped`: Replace or
/// Keep both after all). Under the lock, so two clicks never queue two jobs.
pub fn claim_retry(app: &AppHandle, id: Uuid, skipped: bool) -> Result<(Transfer, JobMeta), String> {
    let files = app.state::<Files>();
    let mut t = files.transfers.lock().unwrap();
    let at = t.list.iter().position(|x| x.id == id).ok_or("no-such-transfer")?;
    let row = &t.list[at];
    let fits = if skipped {
        row.state == TransferState::Skipped
    } else {
        matches!(row.state, TransferState::Failed | TransferState::Cancelled)
    };
    let blocked = row.direction == Direction::DragOut || (skipped && row.direction == Direction::Download);
    if !fits || blocked {
        return Err("not-retryable".into());
    }
    let row = row.clone();
    if !t.claimed.insert(id) {
        return Err("not-retryable".into()); // a retry of it is starting
    }
    let meta = t.jobs.get(&id).cloned().unwrap_or_default();
    Ok((row, meta))
}

/// Ends a `claim_retry`: once the new job is queued (`queued`) the old row
/// goes (`file-transfer-removed`); otherwise it stays, retryable again.
pub fn settle_retry(app: &AppHandle, id: Uuid, queued: bool) {
    let files = app.state::<Files>();
    let mut t = files.transfers.lock().unwrap();
    t.claimed.remove(&id);
    if !queued {
        return;
    }
    t.list.retain(|x| x.id != id);
    t.jobs.remove(&id);
    drop(t);
    let _ = app.emit(FILE_TRANSFER_REMOVED_EVENT, id);
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
            t.prune();
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
    /// The name on the server, when not the local one (a retry of a
    /// "keep both" upload).
    pub name: Option<String>,
    pub conflict: Conflict,
    /// The endpoint it must run against (the panel's, or a retried job's);
    /// None binds to the tunnel's endpoint now.
    pub expect: Option<String>,
    /// A retry: what the earlier run(s) finished.
    pub placed: Placed,
    /// A retry: the earlier run made the target itself (`JobMeta::owns`).
    pub owns: bool,
}

pub struct DownloadJob {
    pub remote: String,
    pub local_dir: PathBuf,
    pub open_when_done: bool,
    pub expect: Option<String>,
    /// A retry: what the earlier run(s) finished, the folder they made
    /// included (it goes on there).
    pub placed: Placed,
}

/// What a queued job may run against: `expect` when given, else the endpoint
/// the tunnel reaches now (see `endpoint_now`).
pub fn bind(app: &AppHandle, tunnel_id: Uuid, expect: Option<String>) -> Option<String> {
    expect.or_else(|| endpoint_now(app, tunnel_id))
}

/// Queues one transfer and returns its id; it runs when a slot frees up.
pub fn start_upload(app: &AppHandle, tunnel_id: Uuid, job: UploadJob) -> Uuid {
    let name = job.name.clone().unwrap_or_else(|| {
        job.local
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
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
        files_done: 0,
        files_failed: 0,
        failures: Vec::new(),
        endpoint: None,
        dest_endpoint: None,
    };
    let expect = bind(app, tunnel_id, job.expect.clone());
    let meta = JobMeta { conflict: Some(job.conflict), endpoint: expect.clone(), dest_endpoint: None, placed: job.placed.clone(), owns: job.owns };
    spawn(app, transfer, meta, move |ctx| Box::pin(upload(ctx, tunnel_id, expect, job)))
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
        files_done: 0,
        files_failed: 0,
        failures: Vec::new(),
        endpoint: None,
        dest_endpoint: None,
    };
    let expect = bind(app, tunnel_id, job.expect.clone());
    let meta = JobMeta { conflict: None, endpoint: expect.clone(), dest_endpoint: None, placed: job.placed.clone(), owns: false };
    spawn(app, transfer, meta, move |ctx| Box::pin(download(ctx, tunnel_id, expect, job)))
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
    files_done: AtomicU32,
    failures: Mutex<(u32, Vec<String>)>,
    /// What this job (and the runs it retries) finished; see `Placed`.
    placed: Mutex<Placed>,
    /// Names held by `free_remote` until the job ends.
    reserved: Mutex<Vec<String>>,
    /// See `JobMeta::owns`.
    owns: AtomicBool,
    /// The SFTP channels the job used: dropped from the cache if it ends on
    /// a dead channel (never a newer one opened meanwhile).
    channels: Mutex<Vec<(Uuid, Arc<SftpSession>)>>,
}

impl Ctx {
    pub(super) fn set_total(&self, total: u64) {
        self.transfer.lock().unwrap().total = total;
    }
    fn set_remote(&self, path: &str) {
        let mut t = self.transfer.lock().unwrap();
        t.remote_path = path.to_string();
        t.name = split(path).1.to_string();
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
    pub(super) fn file_done(&self) {
        self.files_done.fetch_add(1, Ordering::Relaxed);
    }
    /// A file got its final name (or a download folder was made): counted,
    /// and remembered for a retry.
    pub(super) fn placed(&self, key: &str, at: &str, file: bool) {
        self.placed.lock().unwrap().insert(key.to_string(), at.to_string());
        if file {
            self.file_done();
        }
    }
    /// Where an earlier run put `key`, if it finished it.
    pub(super) fn placed_at(&self, key: &str) -> Option<String> {
        self.placed.lock().unwrap().get(key).cloned()
    }
    /// Whether an earlier run finished anything.
    pub(super) fn placed_any(&self) -> bool {
        !self.placed.lock().unwrap().is_empty()
    }
    /// The paths recorded at or under `key`.
    pub(super) fn placed_under(&self, key: &str) -> Vec<String> {
        let below = format!("{}/", key.trim_end_matches('/'));
        self.placed.lock().unwrap().keys().filter(|k| *k == key || k.starts_with(&below)).cloned().collect()
    }
    /// Forgets `key` and everything recorded under it (a folder that has to
    /// be made again: its old records describe another tree).
    fn forget_under(&self, key: &str) {
        let below = format!("{}/", key.trim_end_matches('/'));
        self.placed.lock().unwrap().retain(|k, _| k != key && !k.starts_with(&below));
    }
    /// Notes an SFTP channel the job runs over (see `channels`).
    pub(super) fn uses(&self, tunnel: Uuid, sftp: &Arc<SftpSession>) {
        self.channels.lock().unwrap().push((tunnel, sftp.clone()));
    }
    /// The job made its target itself.
    pub(super) fn own(&self) {
        self.owns.store(true, Ordering::Relaxed);
    }
    /// The tunnels this job runs over.
    fn tunnels(&self) -> Vec<Uuid> {
        let t = self.transfer.lock().unwrap();
        std::iter::once(t.tunnel_id).chain(t.dest_tunnel_id).collect()
    }

    /// The outcome of one file (or folder step) inside a bigger transfer: a
    /// failure that only concerns that entry is noted and the rest goes on;
    /// a cancel or a broken connection stops everything.
    pub(super) fn entry(&self, path: &str, result: Result<(), String>) -> Result<(), String> {
        match result {
            Ok(()) => Ok(()),
            Err(e) if self.cancel.is_cancelled() || stops_all(&e) || self.connection_gone() => Err(e),
            Err(e) => {
                let mut f = self.failures.lock().unwrap();
                f.0 += 1;
                if f.1.len() < MAX_FAILURES {
                    let text = if e.starts_with(path) { e } else { format!("{path}: {e}") };
                    f.1.push(text);
                }
                Ok(())
            }
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

impl Ctx {
    /// A session this job runs over is closed (or gone): every later entry
    /// would fail the same way.
    fn connection_gone(&self) -> bool {
        let state = self.app.state::<AppState>();
        self.tunnels().into_iter().any(|id| state.session_for(id).is_none_or(|s| s.is_closed()))
    }
}

/// Errors that mean the connection (or the whole job) is gone, not one
/// file: the codes `err` and the jobs produce. Read after the last ": ", the
/// one before the error itself (a path may hold any word, and the path in
/// front may be the source's or the target's); codes hold no ": ".
fn stops_all(e: &str) -> bool {
    let bare = e.rsplit_once(": ").map_or(e, |(_, code)| code);
    matches!(bare, "cancelled" | "timeout" | "not-connected" | "target-changed" | "connection-lost")
}

pub(super) fn spawn(
    app: &AppHandle,
    transfer: Transfer,
    meta: JobMeta,
    run: impl FnOnce(Arc<Ctx>) -> JobFuture + Send + 'static,
) -> Uuid {
    let id = transfer.id;
    let cancel = CancellationToken::new();
    let mut transfer = transfer;
    transfer.endpoint = meta.endpoint.clone();
    transfer.dest_endpoint = meta.dest_endpoint.clone();
    {
        let files = app.state::<Files>();
        let mut t = files.transfers.lock().unwrap();
        t.cancels.insert(id, cancel.clone());
        t.jobs.insert(id, meta.clone());
    }
    publish(app, &transfer);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let slots = app.state::<Files>().slots.clone();
        let permit = tokio::select! {
            biased;
            _ = cancel.cancelled() => None,
            p = slots.acquire_owned() => p.ok(),
        };
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
                    files_done: AtomicU32::new(0),
                    failures: Mutex::new((0, Vec::new())),
                    placed: Mutex::new(meta.placed.clone()),
                    reserved: Mutex::new(Vec::new()),
                    owns: AtomicBool::new(meta.owns),
                    channels: Mutex::new(Vec::new()),
                });
                let mut result = run(ctx.clone()).await;
                // Only a channel that broke: a cancel or a host edit leaves a
                // healthy channel other jobs may still be using.
                let broken = |e: &String| {
                    let bare = e.rsplit_once(": ").map_or(e.as_str(), |(_, code)| code);
                    matches!(bare, "connection-lost" | "timeout")
                };
                if result.as_ref().is_err_and(broken) {
                    // A dead SFTP channel on a live session: drop the very
                    // channel that failed, the next job opens a fresh one.
                    let used = std::mem::take(&mut *ctx.channels.lock().unwrap());
                    for (tunnel, sftp) in used {
                        super::forget_channel(&app, tunnel, &sftp).await;
                    }
                }
                {
                    let held = std::mem::take(&mut *ctx.reserved.lock().unwrap());
                    let placed = std::mem::take(&mut *ctx.placed.lock().unwrap());
                    let files = app.state::<Files>();
                    let mut t = files.transfers.lock().unwrap();
                    for name in held {
                        t.reserved.remove(&name);
                    }
                    if let Some(job) = t.jobs.get_mut(&id) {
                        job.placed = placed;
                        job.owns = ctx.owns.load(Ordering::Relaxed);
                    }
                }
                transfer = ctx.transfer.lock().unwrap().clone();
                transfer.done = ctx.done.load(Ordering::Relaxed);
                transfer.files_done = ctx.files_done.load(Ordering::Relaxed);
                let (failed, failures) = std::mem::take(&mut *ctx.failures.lock().unwrap());
                transfer.files_failed = failed;
                transfer.failures = failures;
                if failed > 0 && result.is_ok() {
                    result = Err("partial".to_string());
                }
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
    ctx.uses(tunnel_id, &sftp);
    let name = match &job.name {
        Some(name) => name.clone(),
        None => job.local.file_name().ok_or("no file name")?.to_string_lossy().into_owned(),
    };
    // A link is not uploaded (the same policy as copies between servers).
    // Normalized first: "link/" or "link/." would name what it points to.
    let local: PathBuf = job.local.components().collect();
    let meta = tokio::fs::symlink_metadata(&local).await.map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() || !(meta.is_dir() || meta.is_file()) {
        return Err("not-copied-link".to_string());
    }
    // The real folder, so "keep both" reservations agree on one spelling.
    let dir = sftp.canonicalize(job.remote_dir.as_str()).await.map_err(|e| at(&job.remote_dir, e))?;
    let mut target = join(&dir, &name);
    ctx.set_remote(&target);
    let taken = exists(&sftp, &target).await?;
    let mut mode = match (taken, job.conflict) {
        (false, _) => Write::New,
        (true, Conflict::Skip) => {
            ctx.skipped.store(true, Ordering::Relaxed);
            return Ok(());
        }
        (true, Conflict::Replace) => Write::Replace,
        (true, Conflict::Resume) => Write::Resume,
        (true, Conflict::KeepBoth) => {
            target = free_remote(&ctx, tunnel_id, &sftp, &dir, &name).await?;
            ctx.set_remote(&target);
            Write::New
        }
    };
    if meta.is_dir() {
        ctx.set_total(local_size(&local).await);
    } else {
        ctx.set_total(meta.len());
    }
    // A name taken between the check and the write: "keep both" moves on to
    // the next free one; anything else is skipped, never replaced.
    for _ in 0..5 {
        let result = if meta.is_dir() {
            upload_tree(&ctx, &sftp, &local, &target, mode).await
        } else {
            if already_done(&ctx, &sftp, &target, mode).await? {
                ctx.file_done();
                return Ok(());
            }
            let r = upload_file(&ctx, &sftp, &local, &target, mode == Write::Replace).await;
            if r.is_ok() {
                ctx.placed(&target, &target, true);
                if mode == Write::New {
                    ctx.own();
                }
            }
            r
        };
        match result {
            Err(e) if e == "exists" && job.conflict == Conflict::KeepBoth => {
                target = free_remote(&ctx, tunnel_id, &sftp, &dir, &name).await?;
                ctx.set_remote(&target);
                mode = Write::New;
            }
            Err(e) if e == "exists" => {
                ctx.skipped.store(true, Ordering::Relaxed);
                return Ok(());
            }
            other => return other,
        }
    }
    Err("exists".to_string())
}

/// How a transfer writes into its target.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Write {
    /// The target must not exist (it is created).
    New,
    /// Merge into a folder; replace files.
    Replace,
    /// A retry into the job's own target (it made the name: New or Keep
    /// both): merge, keeping every file already there, since a file only
    /// gets its final name once complete. A retry of Replace stays Replace
    /// and skips only what the earlier run finished (`Placed`): the old
    /// files there were never its own.
    Resume,
}

/// Whether `path` on the server needs no copy on this run: an earlier run
/// finished it, or (Resume) a complete regular file is already there.
pub(super) async fn already_done(ctx: &Ctx, sftp: &SftpSession, path: &str, mode: Write) -> Result<bool, String> {
    let placed = ctx.placed_at(path).is_some();
    if !placed && mode != Write::Resume {
        return Ok(false);
    }
    let there = match sftp.symlink_metadata(path).await {
        Ok(a) => a.is_regular() && !a.is_symlink(),
        Err(e) if is_missing(&e) => false,
        Err(e) => return Err(at(path, e)),
    };
    // A finished file removed (or replaced by something else) since is
    // copied again.
    if placed && !there {
        ctx.forget_under(path);
    }
    Ok(there)
}

/// The first free "name (n).ext" in `dir` on the server, held for this job
/// until it ends so a parallel "keep both" picks the next one. (Its final
/// rename refuses an existing name too, should another program take it.)
pub(super) async fn free_remote(ctx: &Ctx, tunnel: Uuid, sftp: &SftpSession, dir: &str, name: &str) -> Result<String, String> {
    let (stem, ext) = stem_ext(name);
    // Keyed by the machine (host:port, whoever signs in) and the real path.
    let machine = endpoint_now(&ctx.app, tunnel)
        .map(|e| e.rsplit_once('@').map_or(e.clone(), |(_, hp)| hp.to_string()))
        .unwrap_or_else(|| tunnel.to_string());
    for n in 1..10_000 {
        let path = join(dir, &format!("{stem} ({n}){ext}"));
        let key = format!("{machine} {path}");
        // Held before it is probed, so no other job can probe it meanwhile.
        if !ctx.app.state::<Files>().transfers.lock().unwrap().reserved.insert(key.clone()) {
            continue;
        }
        match exists(sftp, &path).await {
            Ok(false) => {
                ctx.reserved.lock().unwrap().push(key);
                return Ok(path);
            }
            other => {
                ctx.app.state::<Files>().transfers.lock().unwrap().reserved.remove(&key);
                other?;
            }
        }
    }
    Err("exists".to_string())
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

/// A local folder onto the server. A file or subfolder that fails is noted
/// (`Ctx::entry`) and the rest goes on; only the top folder must work.
async fn upload_tree(ctx: &Ctx, sftp: &SftpSession, root: &Path, target: &str, mode: Write) -> Result<(), String> {
    let mut stack = vec![(root.to_path_buf(), target.to_string())];
    let mut first = true;
    while let Some((local, remote)) = stack.pop() {
        ctx.check()?;
        let made: Result<(), String> = async {
            match sftp.symlink_metadata(remote.as_str()).await {
                // Merging only into a real folder, never through a link.
                Ok(a) if a.is_dir() && !a.is_symlink() && (mode != Write::New || !first) => Ok(()),
                Ok(_) if first && mode == Write::New => Err("exists".to_string()),
                Ok(_) => Err(format!("{remote}: not a folder")),
                Err(e) if is_missing(&e) => match sftp.create_dir(remote.as_str()).await {
                    Ok(()) => Ok(()),
                    // Made by someone else since the check: a clash, not a failure.
                    Err(_) if first && mode == Write::New && exists(sftp, &remote).await? => Err("exists".to_string()),
                    Err(e) => Err(at(&remote, e)),
                },
                Err(e) => Err(at(&remote, e)),
            }
        }
        .await;
        if first {
            made?;
            if mode == Write::New {
                ctx.own();
            }
        } else if made.is_err() {
            ctx.entry(&remote, made)?;
            continue;
        }
        first = false;
        let mut rd = match tokio::fs::read_dir(&local).await {
            Ok(rd) => rd,
            Err(e) => {
                ctx.entry(&local.to_string_lossy(), Err(e.to_string()))?;
                continue;
            }
        };
        loop {
            let item = match rd.next_entry().await {
                Ok(Some(item)) => item,
                Ok(None) => break,
                Err(e) => {
                    // The rest of this folder can't be read: noted, siblings go on.
                    ctx.entry(&local.to_string_lossy(), Err(e.to_string()))?;
                    break;
                }
            };
            let name = item.file_name().to_string_lossy().into_owned();
            let child = join(&remote, &name);
            match item.file_type().await {
                Err(e) => ctx.entry(&child, Err(e.to_string()))?,
                Ok(t) if t.is_dir() => stack.push((item.path(), child)),
                Ok(t) if t.is_file() => {
                    match already_done(ctx, sftp, &child, mode).await {
                        Ok(true) => {
                            ctx.file_done();
                            continue;
                        }
                        Ok(false) => {}
                        Err(e) => {
                            ctx.entry(&child, Err(e))?;
                            continue;
                        }
                    }
                    // New (our own fresh folder) never replaces: a name
                    // taken by someone else meanwhile is that file's failure.
                    let r = upload_file(ctx, sftp, &item.path(), &child, mode == Write::Replace).await;
                    if r.is_ok() {
                        ctx.placed(&child, &child, true);
                    }
                    ctx.entry(&child, r)?;
                }
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
    let mut dst = create_private(sftp, &part).await.map_err(|e| at(remote, e))?;
    let mut buf = vec![0u8; CHUNK];
    let copied: Result<(), String> = async {
        loop {
            ctx.check()?;
            let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n]).await.map_err(remote_io)?;
            ctx.advance(n as u64);
        }
        dst.shutdown().await.map_err(remote_io)
    }
    .await;
    if let Err(e) = copied {
        drop(dst);
        let _ = sftp.remove_file(part.as_str()).await;
        return Err(e);
    }
    drop(dst);
    // The part was private while it filled; now the mode it is meant to have.
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::metadata(local).await.map_or(0o644, |meta| meta.permissions().mode() & 0o777)
    };
    #[cfg(not(unix))]
    let mode = 0o644; // what a typical server umask gives a new file
    let attrs = FileAttributes { permissions: Some(mode), ..FileAttributes::empty() };
    let _ = sftp.set_metadata(part.as_str(), attrs).await;
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
    ctx.uses(tunnel_id, &sftp);
    let attrs = sftp.metadata(job.remote.as_str()).await.map_err(err)?;
    let (_, name) = split(&job.remote);
    tokio::fs::create_dir_all(&job.local_dir).await.map_err(|e| e.to_string())?;
    // Downloads never overwrite a local file: "name (1).ext" like a browser.
    // A folder is reserved up front (created by us, so ours); a file is
    // written to a private part file and only then published under the
    // first free name (`publish_local`), so nothing placed under the final
    // name meanwhile is ever replaced or deleted.
    if attrs.is_dir() {
        // A retry goes on in the folder the first attempt made (and only
        // that one: a lookalike folder is never taken for it).
        let local = match own_dir(&ctx, &job.remote, &job.local_dir).await {
            Some(dir) => dir,
            None => {
                let dir = reserve_dir(&job.local_dir, name).await?;
                place_dir(&ctx, &job.remote, &dir).await;
                dir
            }
        };
        ctx.set_local(&local);
        let total = remote_size(&ctx, &sftp, &job.remote).await?;
        ctx.set_total(total);
        download_tree(&ctx, &sftp, &job.remote, &local).await
    } else {
        ctx.set_total(attrs.size.unwrap_or(0));
        if let Some(at) = own_file(&ctx, &job.remote, &job.local_dir).await {
            ctx.set_local(&at);
            ctx.file_done();
            return Ok(());
        }
        let local = download_file(&ctx, &sftp, &job.remote, &job.local_dir, name).await?;
        ctx.set_local(&local);
        place_file(&ctx, &job.remote, &local).await;
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
            if !super::valid_name(&item.file_name()) {
                continue;
            }
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

/// The local folder an earlier run made for `remote`, if it is still a real
/// folder (never a link put in its place since).
async fn own_dir(ctx: &Ctx, remote: &str, parent: &Path) -> Option<PathBuf> {
    let recorded = ctx.placed_at(remote)?;
    let (at, id) = recorded.split_once('\0').unwrap_or((&recorded, ""));
    let at = PathBuf::from(at);
    let same = async {
        // Still the very folder it made (not one made in its place since),
        // still where it was, inside its parent, and not a link.
        let meta = tokio::fs::symlink_metadata(&at).await.ok()?;
        let fits = meta.is_dir() && !meta.file_type().is_symlink() && at.parent() == Some(parent) && !id.is_empty() && local_id(&meta) == id;
        fits.then_some(())
    }
    .await;
    if same.is_none() {
        // Made again from scratch: what was recorded under it belongs to
        // the old folder.
        ctx.forget_under(remote);
        return None;
    }
    Some(at)
}

/// Records a file this job downloaded, with its identity (see `own_file`).
async fn place_file(ctx: &Ctx, remote: &str, at: &Path) {
    let id = tokio::fs::symlink_metadata(at).await.map(|m| local_id(&m)).unwrap_or_default();
    ctx.placed(remote, &format!("{}\0{id}", at.to_string_lossy()), true);
}

/// Records a folder this job made, with its identity (see `own_dir`).
async fn place_dir(ctx: &Ctx, remote: &str, dir: &Path) {
    let id = tokio::fs::symlink_metadata(dir).await.map(|m| local_id(&m)).unwrap_or_default();
    ctx.placed(remote, &format!("{}\0{id}", dir.to_string_lossy()), false);
}

/// Where an earlier run downloaded `remote`, if that file is still there in
/// `dir` (a file removed since is downloaded again).
async fn own_file(ctx: &Ctx, remote: &str, dir: &Path) -> Option<PathBuf> {
    let recorded = ctx.placed_at(remote)?;
    let (at, id) = recorded.split_once('\0').unwrap_or((&recorded, ""));
    let at = PathBuf::from(at);
    // The very file it wrote: a file put in its place since is not it.
    let ok = at.parent() == Some(dir)
        && tokio::fs::symlink_metadata(&at)
            .await
            .is_ok_and(|m| m.is_file() && !m.file_type().is_symlink() && !id.is_empty() && local_id(&m) == id);
    if !ok {
        ctx.forget_under(remote);
        return None;
    }
    Some(at)
}

/// What tells one local folder from another made later at the same path.
fn local_id(meta: &std::fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", meta.dev(), meta.ino())
    }
    #[cfg(not(unix))]
    {
        meta.created()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos().to_string())
            .unwrap_or_default()
    }
}

/// A server folder into `local_root`. A file or subfolder that fails is
/// noted (`Ctx::entry`) and the rest goes on. On a retry, folders an earlier
/// run made are reused and files it finished skipped (`Placed`); nothing
/// else on disk is trusted.
async fn download_tree(ctx: &Ctx, sftp: &SftpSession, root: &str, local_root: &Path) -> Result<(), String> {
    let mut stack = vec![(root.to_string(), local_root.to_path_buf())];
    while let Some((remote, local)) = stack.pop() {
        ctx.check()?;
        let items = match sftp.read_dir(&remote).await {
            Ok(items) => items,
            Err(e) if remote == root => return Err(at(&remote, e)),
            Err(e) => {
                ctx.entry(&remote, Err(at(&remote, e)))?;
                continue;
            }
        };
        for item in items {
            ctx.check()?;
            let meta = item.metadata();
            let name = item.file_name();
            if !super::valid_name(&name) {
                ctx.entry(&remote, Err(format!("{remote}: invalid name from server")))?;
                continue;
            }
            let path = item.path();
            // Names that differ remotely but not as local names (`a:b`, `a?b`)
            // get "(1)" instead of landing on each other.
            if meta.is_dir() && !meta.is_symlink() {
                if let Some(dir) = own_dir(ctx, &path, &local).await {
                    stack.push((path, dir));
                    continue;
                }
                match reserve_dir(&local, &name).await {
                    Ok(child) => {
                        place_dir(ctx, &path, &child).await;
                        stack.push((path, child));
                    }
                    Err(e) => ctx.entry(&path, Err(e))?,
                }
            } else if meta.is_regular() {
                if own_file(ctx, &path, &local).await.is_some() {
                    ctx.file_done();
                    continue;
                }
                let r = download_file(ctx, sftp, &path, &local, &name).await;
                let r = match r {
                    Ok(at) => {
                        place_file(ctx, &path, &at).await;
                        Ok(())
                    }
                    Err(e) => Err(e),
                };
                ctx.entry(&path, r)?;
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
            let n = src.read(&mut buf).await.map_err(remote_io)?;
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
