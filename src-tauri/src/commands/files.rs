//! The terminal's file popup: SFTP on a tunnel's live session (`ssh::sftp`).
//!
//! Every command takes the tunnel id of the pane the popup belongs to and
//! fails with "not-connected" when that tunnel has no live session: the popup
//! never connects anything by itself.

use std::path::PathBuf;
use std::time::Instant;

use tauri::ipc::Response;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

use crate::ssh::sftp::{
    self, Conflict, Content, Count, Direction, DownloadJob, Expect, Listing, PasteOutcome, Properties, Saved,
    Transfer, UploadJob,
};
pub use crate::ssh::sftp::CopyAcross;
use crate::AppState;

/// A failed call may mean the session died under the channel; drop the cache
/// so the next call reopens instead of failing forever.
async fn settle<T>(app: &AppHandle, tunnel_id: Uuid, started: Instant, result: Result<T, String>) -> Result<T, String> {
    if let Err(e) = &result {
        let alive = app
            .state::<AppState>()
            .session_for(tunnel_id)
            .is_some_and(|s| !s.is_closed());
        // The SFTP channel can die alone (server subsystem exit) while SSH
        // lives on: transport-level errors reopen it next time too.
        let channel_broken = e == "timeout" || e.starts_with("I/O") || e.contains("closed") || e == "Unexpected packet";
        // `sftp::err` already names a dead channel "connection-lost" (also
        // after a path prefix): drop it whenever it was opened, even by
        // this very call, or every retry picks it up again.
        let bare = e.rsplit_once(": ").map_or(e.as_str(), |(_, code)| code);
        if matches!(bare, "connection-lost" | "timeout") {
            sftp::forget(app, tunnel_id, Instant::now()).await;
        } else if !alive || channel_broken {
            sftp::forget(app, tunnel_id, started).await;
        }
    }
    result
}

fn session(state: &AppState, tunnel_id: Uuid) -> Result<std::sync::Arc<russh::client::Handle<crate::ssh::SshHandler>>, String> {
    state.session_for(tunnel_id).ok_or_else(|| "not-connected".to_string())
}

/// The login directory (where a relative path starts).
#[tauri::command]
pub async fn files_home(app: AppHandle, tunnel_id: Uuid) -> Result<String, String> {
    let started = Instant::now();
    let r = async {
        let s = sftp::sftp_for(&app, tunnel_id).await?;
        s.canonicalize(".").await.map_err(sftp::err)
    }
    .await;
    settle(&app, tunnel_id, started, r).await
}

#[tauri::command]
pub async fn files_list(app: AppHandle, tunnel_id: Uuid, path: String) -> Result<Listing, String> {
    let started = Instant::now();
    let r = async { sftp::list(&*sftp::sftp_for(&app, tunnel_id).await?, &path).await }.await;
    settle(&app, tunnel_id, started, r).await
}

#[tauri::command]
pub async fn files_properties(
    app: AppHandle,
    state: State<'_, AppState>,
    tunnel_id: Uuid,
    path: String,
) -> Result<Properties, String> {
    let started = Instant::now();
    let r = async {
        let s = sftp::sftp_for(&app, tunnel_id).await?;
        sftp::properties(&*session(&state, tunnel_id)?, &s, &path).await
    }
    .await;
    settle(&app, tunnel_id, started, r).await
}

#[tauri::command]
pub async fn files_dir_size(state: State<'_, AppState>, tunnel_id: Uuid, path: String) -> Result<u64, String> {
    sftp::dir_size(&*session(&state, tunnel_id)?, &path).await
}

#[tauri::command]
pub async fn files_create(app: AppHandle, tunnel_id: Uuid, path: String, dir: bool, endpoint: Option<String>) -> Result<(), String> {
    let started = Instant::now();
    let r = async {
        let s = sftp::sftp_bound(&app, tunnel_id, endpoint.as_deref()).await?;
        if dir {
            sftp::create_dir(&s, &path).await
        } else {
            sftp::create_file(&s, &path).await
        }
    }
    .await;
    settle(&app, tunnel_id, started, r).await
}

#[tauri::command]
pub async fn files_rename(
    app: AppHandle,
    tunnel_id: Uuid,
    from: String,
    to: String,
    endpoint: Option<String>,
) -> Result<(), String> {
    let started = Instant::now();
    let r = async { sftp::rename(&*sftp::sftp_bound(&app, tunnel_id, endpoint.as_deref()).await?, &from, &to).await }.await;
    settle(&app, tunnel_id, started, r).await
}

/// What a delete would remove, for its confirmation.
#[tauri::command]
pub async fn files_count(app: AppHandle, tunnel_id: Uuid, paths: Vec<String>) -> Result<Count, String> {
    let started = Instant::now();
    let r = async { sftp::count(&*sftp::sftp_for(&app, tunnel_id).await?, &paths).await }.await;
    settle(&app, tunnel_id, started, r).await
}

#[tauri::command]
/// `endpoint`: the server the confirmation named; a host edited since gets
/// nothing deleted (likewise create, rename and save).
pub async fn files_delete(app: AppHandle, tunnel_id: Uuid, paths: Vec<String>, endpoint: Option<String>) -> Result<(), String> {
    let started = Instant::now();
    let r = async { sftp::delete(&*sftp::sftp_bound(&app, tunnel_id, endpoint.as_deref()).await?, &paths).await }.await;
    settle(&app, tunnel_id, started, r).await
}

#[tauri::command]
pub async fn files_paste(
    app: AppHandle,
    tunnel_id: Uuid,
    sources: Vec<String>,
    dest_dir: String,
    cut: bool,
    // The server the rows were copied or cut on: a host edited since to
    // reach another one gets nothing moved.
    endpoint: Option<String>,
) -> Result<PasteOutcome, String> {
    let started = Instant::now();
    let r = async {
        // One session, checked once, for both the SFTP calls and `cp`.
        let (session, s) = sftp::bound_session(&app, tunnel_id, endpoint.as_deref()).await?;
        sftp::paste(&session, &s, &sources, &dest_dir, cut).await
    }
    .await;
    settle(&app, tunnel_id, started, r).await
}

#[tauri::command]
pub async fn files_copy_across(
    app: AppHandle,
    state: State<'_, AppState>,
    from_tunnel_id: Uuid,
    sources: Vec<String>,
    to_tunnel_id: Uuid,
    dest_dir: String,
    conflict: Conflict,
    target_name: Option<String>,
    // The endpoints the source and target panels show.
    from_endpoint: Option<String>,
    to_endpoint: Option<String>,
) -> Result<CopyAcross, String> {
    let prior = sftp::JobMeta { endpoint: from_endpoint, dest_endpoint: to_endpoint, ..Default::default() };
    sftp::copy_across(&app, &state, from_tunnel_id, sources, to_tunnel_id, dest_dir, conflict, target_name, prior).await
}

/// Which of `names` already exist in `dir`: asked before an upload or a
/// copy, so the user picks Skip / Replace / Keep both per clash.
#[tauri::command]
pub async fn files_existing(
    app: AppHandle,
    tunnel_id: Uuid,
    dir: String,
    names: Vec<String>,
    endpoint: Option<String>,
) -> Result<Vec<String>, String> {
    let started = Instant::now();
    let r = async {
        let s = sftp::sftp_bound(&app, tunnel_id, endpoint.as_deref()).await?;
        let mut taken = Vec::new();
        for name in names {
            if sftp::exists(&s, &sftp::join(&dir, &name)).await? {
                taken.push(name);
            }
        }
        Ok(taken)
    }
    .await;
    settle(&app, tunnel_id, started, r).await
}

/// Runs a failed or cancelled transfer again, picking up where it stopped
/// (on the server it ran against, never one the host was edited to reach
/// since): what it finished is kept, a Replace goes on replacing the rest.
/// With `conflict`, runs a skipped row again as Replace or Keep both. The
/// old row goes (`file-transfer-removed`); the new one carries on.
#[tauri::command]
pub async fn files_retry(
    app: AppHandle,
    state: State<'_, AppState>,
    id: Uuid,
    // A skipped row run again as Replace or Keep both; None: a retry.
    conflict: Option<Conflict>,
) -> Result<Vec<Uuid>, String> {
    if conflict.is_some_and(|c| !matches!(c, Conflict::Replace | Conflict::KeepBoth)) {
        return Err("not-retryable".into());
    }
    // Claimed first, so a second click finds it busy; the row stays until
    // the new job is queued, so a refused retry can be tried again.
    let (old, meta) = sftp::claim_retry(&app, id, conflict.is_some())?;
    let result = rerun(&app, &state, old, meta, conflict).await;
    sftp::settle_retry(&app, id, result.is_ok());
    result
}

async fn rerun(
    app: &AppHandle,
    state: &AppState,
    old: sftp::Transfer,
    meta: sftp::JobMeta,
    conflict: Option<Conflict>,
) -> Result<Vec<Uuid>, String> {
    let app = app.clone();
    // A Replace keeps replacing what the earlier run did not finish. A job
    // that made its target itself merges into it keeping what is there.
    // One that never got that far starts over with its first choice, so a
    // name someone else took meanwhile is never taken for finished.
    let conflict = conflict.unwrap_or(match meta.conflict {
        Some(Conflict::Replace) => Conflict::Replace,
        _ if meta.owns => Conflict::Resume,
        Some(first) => first,
        None => Conflict::Skip,
    });
    let ids = match old.direction {
        Direction::Upload => {
            let (dir, name) = sftp::split(&old.remote_path);
            vec![sftp::start_upload(
                &app,
                old.tunnel_id,
                UploadJob {
                    local: PathBuf::from(&old.local_path),
                    remote_dir: dir.to_string(),
                    name: Some(name.to_string()),
                    conflict,
                    expect: meta.endpoint,
                    placed: meta.placed,
                    owns: meta.owns,
                },
            )]
        }
        Direction::Download => {
            // The folder the first run picked; the job goes on in the one it
            // made itself (`Placed`), or reserves a fresh one.
            let local = PathBuf::from(&old.local_path);
            let local_dir = local.parent().map(PathBuf::from).unwrap_or(local);
            vec![sftp::start_download(
                &app,
                old.tunnel_id,
                DownloadJob {
                    remote: old.remote_path.clone(),
                    local_dir,
                    open_when_done: old.open_when_done,
                    expect: meta.endpoint,
                    placed: meta.placed,
                },
            )]
        }
        Direction::Copy => {
            let to = old.dest_tunnel_id.ok_or("no-such-transfer")?;
            sftp::copy_across(
                &app,
                state,
                old.tunnel_id,
                vec![old.remote_path.clone()],
                to,
                old.local_path.clone(),
                conflict,
                Some(old.name.clone()),
                meta,
            )
            .await?
            .transfer_ids
        }
        Direction::DragOut => return Err("not-retryable".into()),
    };
    Ok(ids)
}

#[tauri::command]
pub async fn files_read_text(app: AppHandle, tunnel_id: Uuid, path: String, tail: bool) -> Result<Content, String> {
    let started = Instant::now();
    let r = async { sftp::read_text(&*sftp::sftp_for(&app, tunnel_id).await?, &path, tail).await }.await;
    settle(&app, tunnel_id, started, r).await
}

/// An image's bytes, as an `ArrayBuffer` (never a JSON number array).
#[tauri::command]
pub async fn files_read_image(app: AppHandle, tunnel_id: Uuid, path: String) -> Result<Response, String> {
    let started = Instant::now();
    let r = async { sftp::read_bytes(&*sftp::sftp_for(&app, tunnel_id).await?, &path).await }.await;
    settle(&app, tunnel_id, started, r).await.map(Response::new)
}

/// Saves of one file run one at a time, so two editors on it in this app
/// can't both pass the change check before either lands.
static SAVING: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<(Uuid, String), std::sync::Arc<tokio::sync::Mutex<()>>>>> =
    std::sync::LazyLock::new(Default::default);

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn files_write_text(
    app: AppHandle,
    tunnel_id: Uuid,
    path: String,
    text: String,
    expect_size: u64,
    expect_mtime: Option<u32>,
    expect_hash: Option<String>,
    force: bool,
    in_place: bool,
    endpoint: Option<String>,
) -> Result<Saved, String> {
    let gate = {
        let mut saving = SAVING.lock().unwrap();
        saving.retain(|_, gate| std::sync::Arc::strong_count(gate) > 1);
        saving.entry((tunnel_id, path.clone())).or_default().clone()
    };
    let _one_at_a_time = gate.lock().await;
    let started = Instant::now();
    let r = async {
        let s = sftp::sftp_bound(&app, tunnel_id, endpoint.as_deref()).await?;
        let expect = Expect { size: expect_size, mtime: expect_mtime, hash: expect_hash };
        sftp::write_text(&s, &path, &text, &expect, force, in_place).await
    }
    .await;
    settle(&app, tunnel_id, started, r).await
}

/// Uploads local files or folders (dropped on the popup) into `remote_dir`;
/// a taken name follows `conflict`. `endpoint`: the server the panel shows
/// (the job refuses another one).
#[tauri::command]
pub fn files_upload(
    app: AppHandle,
    tunnel_id: Uuid,
    local_paths: Vec<String>,
    remote_dir: String,
    conflict: Conflict,
    endpoint: Option<String>,
) -> Result<Vec<Uuid>, String> {
    // Two items for one name would race for it on the server.
    let mut names: Vec<_> = local_paths.iter().map(|p| PathBuf::from(p).file_name().map(|n| n.to_owned())).collect();
    if names.iter().any(Option::is_none) {
        return Err("invalid-path".into());
    }
    names.sort_unstable();
    if names.windows(2).any(|w| w[0] == w[1]) {
        return Err("duplicate-names".into());
    }
    Ok(local_paths
        .into_iter()
        .map(|local| {
            sftp::start_upload(
                &app,
                tunnel_id,
                UploadJob {
                    local: PathBuf::from(local),
                    remote_dir: remote_dir.clone(),
                    name: None,
                    conflict,
                    expect: endpoint.clone(),
                    placed: Default::default(),
                    owns: false,
                },
            )
        })
        .collect())
}

/// The upload button: the OS file picker (Rust side). Returns the picked
/// paths (only paths reach the webview, never contents); the panel resolves
/// name clashes and then calls `files_upload`.
#[tauri::command]
pub async fn files_pick_upload(app: AppHandle, window: WebviewWindow) -> Result<Vec<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_parent(&window).pick_files(move |paths| {
        let _ = tx.send(paths);
    });
    let Some(paths) = rx.await.map_err(|_| "file dialog closed".to_string())? else {
        return Ok(Vec::new());
    };
    Ok(paths
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect())
}

/// Downloads into the user's Downloads folder; local names never clash.
#[tauri::command]
pub fn files_download(
    app: AppHandle,
    tunnel_id: Uuid,
    remote_paths: Vec<String>,
    endpoint: Option<String>,
) -> Result<Vec<Uuid>, String> {
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| e.to_string())?;
    Ok(remote_paths
        .into_iter()
        .map(|remote| {
            sftp::start_download(
                &app,
                tunnel_id,
                DownloadJob { remote, local_dir: dir.clone(), open_when_done: false, expect: endpoint.clone(), placed: Default::default() },
            )
        })
        .collect())
}

/// "Download to folder…": a folder picker (Rust side) starting in the last
/// folder chosen, then one download per path into it. Cancel queues nothing.
#[tauri::command]
pub async fn files_pick_download(
    app: AppHandle,
    window: WebviewWindow,
    tunnel_id: Uuid,
    remote_paths: Vec<String>,
    endpoint: Option<String>,
) -> Result<Vec<Uuid>, String> {
    let state = app.state::<AppState>();
    let start = state
        .settings
        .get()
        .files_download_dir
        .as_ref()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| app.path().download_dir().ok());
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_parent(&window);
    if let Some(start) = start {
        dialog = dialog.set_directory(start);
    }
    dialog.pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let Some(picked) = rx.await.map_err(|_| "file dialog closed".to_string())? else {
        return Ok(Vec::new());
    };
    let dir = picked.into_path().map_err(|e| e.to_string())?;
    let fresh = state.settings.modify_or_log(|settings| {
        settings.files_download_dir = Some(dir.to_string_lossy().into_owned());
    });
    let _ = tauri::Emitter::emit(&app, crate::events::SETTINGS_CHANGED_EVENT, &fresh);
    Ok(remote_paths
        .into_iter()
        .map(|remote| {
            sftp::start_download(
                &app,
                tunnel_id,
                DownloadJob { remote, local_dir: dir.clone(), open_when_done: false, expect: endpoint.clone(), placed: Default::default() },
            )
        })
        .collect())
}

#[tauri::command]
pub async fn files_drag_out(
    app: AppHandle,
    window: WebviewWindow,
    tunnel_id: Uuid,
    paths: Vec<String>,
    endpoint: Option<String>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let started = Instant::now();
        let result = crate::ssh::drag_out::start(&app, window, tunnel_id, paths, endpoint).await;
        settle(&app, tunnel_id, started, result).await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, window, tunnel_id, paths, endpoint);
        Err("unsupported".into())
    }
}

/// "Open with the system app": a temp copy, opened once downloaded. Edits to
/// it are not sent back.
#[tauri::command]
pub fn files_open_local(app: AppHandle, tunnel_id: Uuid, remote_path: String, endpoint: Option<String>) -> Result<Uuid, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("open")
        .join(Uuid::new_v4().simple().to_string());
    Ok(sftp::start_download(
        &app,
        tunnel_id,
        DownloadJob { remote: remote_path, local_dir: dir, open_when_done: true, expect: endpoint, placed: Default::default() },
    ))
}

/// The queue, for a webview that reloads (events carry the changes).
#[tauri::command]
pub fn files_transfers(app: AppHandle) -> Vec<Transfer> {
    sftp::transfers(&app)
}

#[tauri::command]
pub fn files_cancel_transfer(app: AppHandle, id: Uuid) {
    sftp::cancel(&app, id);
}

#[tauri::command]
pub fn files_clear_transfers(app: AppHandle, tunnel_id: Option<Uuid>) {
    sftp::clear_finished(&app, tunnel_id);
}

/// Shows a finished download in the file manager. Only paths the queue wrote.
#[tauri::command]
pub fn files_reveal(app: AppHandle, id: Uuid) -> Result<(), String> {
    let transfer = sftp::transfers(&app)
        .into_iter()
        .find(|t| t.id == id)
        .ok_or("unknown transfer")?;
    if transfer.direction == Direction::Copy {
        return Err("unsupported".to_string());
    }
    tauri_plugin_opener::reveal_item_in_dir(&transfer.local_path).map_err(|e| e.to_string())
}

/// Saves an editor draft to a local file (its session died before saving).
#[tauri::command]
pub async fn files_save_draft(
    app: AppHandle,
    window: WebviewWindow,
    name: String,
    text: String,
) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_file_name(sftp::sanitize(&name))
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx.await.map_err(|_| "file dialog closed".to_string())? else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| format!("unusable path: {e}"))?;
    crate::settings::write_atomic(&path, text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}
