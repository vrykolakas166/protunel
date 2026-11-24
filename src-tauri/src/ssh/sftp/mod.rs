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
pub use preview::{read_bytes, read_text, write_text, Content, Saved};

pub use transfers::{
    cancel, clear_finished, start_download, start_upload, transfers, Direction, DownloadJob, Route,
    Transfer, TransferState, UploadJob,
};

use operations::delete_tree;
use transfers::{commit_part, remote_size, short_id, spawn, Ctx, Transfers, PARALLEL_TRANSFERS};

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
}

/// Open SFTP channels and the transfer queue. Managed state.
pub struct Files {
    cache: tokio::sync::Mutex<HashMap<Uuid, Cached>>,
    copy_probes: copy_across::Probes,
    transfers: Mutex<Transfers>,
    slots: Arc<Semaphore>,
}

impl Default for Files {
    fn default() -> Self {
        Self {
            cache: tokio::sync::Mutex::new(HashMap::new()),
            copy_probes: copy_across::Probes::default(),
            transfers: Mutex::new(Transfers::default()),
            slots: Arc::new(Semaphore::new(PARALLEL_TRANSFERS)),
        }
    }
}

/// The SFTP channel of a tunnel's current session, opened on first use.
pub async fn sftp_for(app: &AppHandle, tunnel_id: Uuid) -> Result<Arc<SftpSession>, String> {
    let state = app.state::<AppState>();
    let session = state.session_for(tunnel_id).ok_or("not-connected")?;
    sftp_for_session(app, tunnel_id, &session).await
}

async fn sftp_for_session(app: &AppHandle, tunnel_id: Uuid, session: &Arc<Handle>) -> Result<Arc<SftpSession>, String> {
    let files = app.state::<Files>();
    {
        let cache = files.cache.lock().await;
        if let Some(entry) = cache.get(&tunnel_id) {
            if entry.session.upgrade().is_some_and(|s| Arc::ptr_eq(&s, session)) {
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
        Cached { session: Arc::downgrade(session), sftp: sftp.clone() },
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
