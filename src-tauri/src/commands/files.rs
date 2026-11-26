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
    self, Content, Count, Direction, DownloadJob, Expect, Listing, PasteOutcome, Properties, Saved, Transfer,
    UploadJob,
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
        if !alive || channel_broken {
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
pub async fn files_create(app: AppHandle, tunnel_id: Uuid, path: String, dir: bool) -> Result<(), String> {
    let started = Instant::now();
    let r = async {
        let s = sftp::sftp_for(&app, tunnel_id).await?;
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
pub async fn files_rename(app: AppHandle, tunnel_id: Uuid, from: String, to: String) -> Result<(), String> {
    let started = Instant::now();
    let r = async { sftp::rename(&*sftp::sftp_for(&app, tunnel_id).await?, &from, &to).await }.await;
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
pub async fn files_delete(app: AppHandle, tunnel_id: Uuid, paths: Vec<String>) -> Result<(), String> {
    let started = Instant::now();
    let r = async { sftp::delete(&*sftp::sftp_for(&app, tunnel_id).await?, &paths).await }.await;
    settle(&app, tunnel_id, started, r).await
}

#[tauri::command]
pub async fn files_paste(
    app: AppHandle,
    state: State<'_, AppState>,
    tunnel_id: Uuid,
    sources: Vec<String>,
    dest_dir: String,
    cut: bool,
) -> Result<PasteOutcome, String> {
    let started = Instant::now();
    let r = async {
        let s = sftp::sftp_for(&app, tunnel_id).await?;
        sftp::paste(&*session(&state, tunnel_id)?, &s, &sources, &dest_dir, cut).await
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
    overwrite: bool,
) -> Result<CopyAcross, String> {
    sftp::copy_across(&app, &state, from_tunnel_id, sources, to_tunnel_id, dest_dir, overwrite).await
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
) -> Result<Saved, String> {
    let gate = {
        let mut saving = SAVING.lock().unwrap();
        saving.retain(|_, gate| std::sync::Arc::strong_count(gate) > 1);
        saving.entry((tunnel_id, path.clone())).or_default().clone()
    };
    let _one_at_a_time = gate.lock().await;
    let started = Instant::now();
    let r = async {
        let s = sftp::sftp_for(&app, tunnel_id).await?;
        let expect = Expect { size: expect_size, mtime: expect_mtime, hash: expect_hash };
        sftp::write_text(&s, &path, &text, &expect, force, in_place).await
    }
    .await;
    settle(&app, tunnel_id, started, r).await
}

/// Uploads local files or folders (dropped on the popup) into `remote_dir`.
/// Existing names are skipped unless `overwrite`.
#[tauri::command]
pub fn files_upload(
    app: AppHandle,
    tunnel_id: Uuid,
    local_paths: Vec<String>,
    remote_dir: String,
    overwrite: bool,
) -> Vec<Uuid> {
    local_paths
        .into_iter()
        .map(|local| {
            sftp::start_upload(
                &app,
                tunnel_id,
                UploadJob { local: PathBuf::from(local), remote_dir: remote_dir.clone(), overwrite },
            )
        })
        .collect()
}

/// The upload button: the OS file picker (Rust side), then `files_upload`.
#[tauri::command]
pub async fn files_pick_upload(
    app: AppHandle,
    window: WebviewWindow,
    tunnel_id: Uuid,
    remote_dir: String,
) -> Result<Vec<Uuid>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_parent(&window).pick_files(move |paths| {
        let _ = tx.send(paths);
    });
    let Some(paths) = rx.await.map_err(|_| "file dialog closed".to_string())? else {
        return Ok(Vec::new());
    };
    let locals = paths
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    Ok(files_upload(app, tunnel_id, locals, remote_dir, false))
}

/// Downloads into the user's Downloads folder; local names never clash.
#[tauri::command]
pub fn files_download(app: AppHandle, tunnel_id: Uuid, remote_paths: Vec<String>) -> Result<Vec<Uuid>, String> {
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
                DownloadJob { remote, local_dir: dir.clone(), open_when_done: false },
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
                DownloadJob { remote, local_dir: dir.clone(), open_when_done: false },
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
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let started = Instant::now();
        let result = crate::ssh::drag_out::start(&app, window, tunnel_id, paths).await;
        settle(&app, tunnel_id, started, result).await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, window, tunnel_id, paths);
        Err("unsupported".into())
    }
}

/// "Open with the system app": a temp copy, opened once downloaded. Edits to
/// it are not sent back.
#[tauri::command]
pub fn files_open_local(app: AppHandle, tunnel_id: Uuid, remote_path: String) -> Result<Uuid, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("open")
        .join(Uuid::new_v4().simple().to_string());
    Ok(sftp::start_download(
        &app,
        tunnel_id,
        DownloadJob { remote: remote_path, local_dir: dir, open_when_done: true },
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
