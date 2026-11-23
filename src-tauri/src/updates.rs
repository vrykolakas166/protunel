//! In-app updates, owned by the backend so they keep working while the app
//! sits in the tray for days with its window hidden.
//!
//! - Checks shortly after launch, then every `CHECK_INTERVAL`.
//! - With `settings.auto_update`, a found update is downloaded (and its
//!   signature verified) in the background; the user then restarts when it
//!   suits them, from the banner, the About page or the tray menu.
//! - On a self-updating Linux build (AppImage) a ready update is also applied
//!   when the user quits. Not on Windows: its installer relaunches the app,
//!   which would undo the user's "Exit".
//! - Restarting to update remembers which tunnels were up (`resume.json`) so
//!   they come back, and keeps the release notes (`whats_new.json`) so the new
//!   version can show them once.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use uuid::Uuid;

use crate::events::UPDATE_STATUS_EVENT;
use crate::AppState;

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(20);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Copy, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    #[default]
    Idle,
    Checking,
    /// Found, not downloaded (automatic download is off, or it failed).
    Available,
    Downloading,
    /// Downloaded and verified; installs on restart.
    Ready,
    Error,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSnapshot {
    /// This build can update itself (Windows, AppImage). Package-manager
    /// installs cannot, and never check.
    pub supported: bool,
    pub phase: UpdatePhase,
    pub version: Option<String>,
    pub notes: Option<String>,
    /// 0.0–1.0 while downloading, when the server sent a size.
    pub progress: Option<f32>,
    pub error: Option<String>,
    /// Unix seconds of the last completed check.
    pub last_checked: Option<u64>,
    /// A ready update is applied when the app quits (AppImage only).
    pub installs_on_exit: bool,
}

#[derive(Default)]
struct Inner {
    snapshot: UpdateSnapshot,
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
    /// A check or download is running; a second request just reports.
    busy: bool,
    /// The state was put there by the developer tools (`simulate`): there is
    /// no package behind it, and "installing" only restarts.
    simulated: bool,
}

#[derive(Default)]
pub struct Updates(Mutex<Inner>);

/// Release notes of the version just installed, shown once by that version.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhatsNew {
    pub version: String,
    pub notes: String,
}

fn supported() -> bool {
    cfg!(windows) || std::env::var_os("APPIMAGE").is_some()
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn data_file(app: &AppHandle, name: &str) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join(name))
}

impl Updates {
    pub fn snapshot(&self) -> UpdateSnapshot {
        let inner = self.0.lock().unwrap();
        let mut snapshot = inner.snapshot.clone();
        snapshot.supported = supported() || inner.simulated;
        drop(inner);
        snapshot.installs_on_exit = supported() && !cfg!(windows);
        snapshot
    }

    fn set(&self, app: &AppHandle, change: impl FnOnce(&mut UpdateSnapshot)) {
        change(&mut self.0.lock().unwrap().snapshot);
        let _ = app.emit(UPDATE_STATUS_EVENT, self.snapshot());
    }
}

/// Starts the periodic check. Does nothing on builds that cannot update.
pub fn start(app: &AppHandle) {
    if !supported() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            check(&app, false).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

/// Asks the update server. `manual` (the user pressed "Check") also surfaces
/// errors; a background check that fails just tries again next time.
pub async fn check(app: &AppHandle, manual: bool) -> UpdateSnapshot {
    let updates = app.state::<Updates>();
    if !supported() {
        return updates.snapshot();
    }
    {
        let mut inner = updates.0.lock().unwrap();
        // Busy, or already downloaded: nothing new to learn until it installs.
        if inner.busy || inner.snapshot.phase == UpdatePhase::Ready {
            return updates.snapshot();
        }
        inner.busy = true;
    }
    if manual {
        updates.set(app, |s| {
            s.phase = UpdatePhase::Checking;
            s.error = None;
        });
    }

    let result = match app.updater_builder().on_before_exit(before_windows_install(app)).build() {
        Ok(updater) => updater.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };

    let found = match result {
        Ok(Some(update)) => {
            let (version, notes) = (update.version.clone(), update.body.clone());
            updates.0.lock().unwrap().update = Some(update);
            updates.set(app, |s| {
                s.phase = UpdatePhase::Available;
                s.version = Some(version);
                s.notes = notes;
                s.error = None;
                s.last_checked = Some(now());
            });
            true
        }
        Ok(None) => {
            updates.set(app, |s| {
                s.phase = UpdatePhase::Idle;
                s.version = None;
                s.notes = None;
                s.error = None;
                s.last_checked = Some(now());
            });
            false
        }
        Err(e) => {
            updates.set(app, |s| {
                if manual {
                    s.phase = UpdatePhase::Error;
                    s.error = Some(e);
                } else if s.phase == UpdatePhase::Checking {
                    s.phase = UpdatePhase::Idle;
                }
            });
            false
        }
    };
    updates.0.lock().unwrap().busy = false;

    if found && app.state::<AppState>().settings.get().auto_update {
        download(app).await;
    }
    updates.snapshot()
}

/// Downloads (and verifies) the update found by the last check.
pub async fn download(app: &AppHandle) -> UpdateSnapshot {
    let updates = app.state::<Updates>();
    let update = {
        let mut inner = updates.0.lock().unwrap();
        if inner.busy || inner.snapshot.phase != UpdatePhase::Available {
            return updates.snapshot();
        }
        let update = inner.update.clone();
        if update.is_none() && !inner.simulated {
            return updates.snapshot();
        }
        inner.busy = true;
        update
    };
    updates.set(app, |s| {
        s.phase = UpdatePhase::Downloading;
        s.progress = Some(0.0);
        s.error = None;
    });
    let Some(update) = update else {
        fake_download(app).await;
        return updates.snapshot();
    };

    let mut received: u64 = 0;
    let mut last_percent: i32 = -1;
    let progress_app = app.clone();
    let result = update
        .download(
            |chunk, total| {
                received += chunk as u64;
                let Some(total) = total.filter(|t| *t > 0) else { return };
                let fraction = (received as f32 / total as f32).min(1.0);
                // One event per percent, not per network chunk.
                let percent = (fraction * 100.0) as i32;
                if percent != last_percent {
                    last_percent = percent;
                    progress_app.state::<Updates>().set(&progress_app, |s| s.progress = Some(fraction));
                }
            },
            || {},
        )
        .await;

    match result {
        Ok(bytes) => {
            updates.0.lock().unwrap().bytes = Some(bytes);
            mark_ready(app);
        }
        Err(e) => {
            updates.set(app, |s| {
                s.phase = UpdatePhase::Available;
                s.progress = None;
                s.error = Some(e.to_string());
            });
        }
    }
    updates.0.lock().unwrap().busy = false;
    updates.snapshot()
}

/// Downloaded: tell the window, the tray and (if allowed) the desktop.
fn mark_ready(app: &AppHandle) {
    let updates = app.state::<Updates>();
    updates.set(app, |s| {
        s.phase = UpdatePhase::Ready;
        s.progress = None;
    });
    crate::tray::rebuild_menu(app);
    if app.state::<AppState>().settings.get().notifications_enabled {
        let version = updates.snapshot().version.unwrap_or_default();
        let _ = app
            .notification()
            .builder()
            .title(crate::i18n::t_version(app, crate::i18n::Text::UpdateReadyTitle, &version))
            .body(crate::i18n::t(app, crate::i18n::Text::UpdateReadyBody))
            .show();
    }
}

/// The version a ready update installs, for the tray menu.
pub fn ready_version(app: &AppHandle) -> Option<String> {
    let snapshot = app.try_state::<Updates>()?.snapshot();
    (snapshot.phase == UpdatePhase::Ready).then_some(snapshot.version).flatten()
}

/// Takes the downloaded package out, so it can only ever be installed once
/// (restart-to-update and the exit hook can both get here).
fn take_ready(app: &AppHandle) -> Option<(Update, Vec<u8>)> {
    let updates = app.try_state::<Updates>()?;
    let mut inner = updates.0.lock().unwrap();
    if inner.snapshot.phase != UpdatePhase::Ready {
        return None;
    }
    Some((inner.update.clone()?, inner.bytes.take()?))
}

fn save_whats_new(app: &AppHandle, update: &Update) {
    write_whats_new(app, &WhatsNew {
        version: update.version.clone(),
        notes: update.body.clone().unwrap_or_default(),
    });
}

fn write_whats_new(app: &AppHandle, whats_new: &WhatsNew) {
    let Some(path) = data_file(app, "whats_new.json") else { return };
    if let Ok(json) = serde_json::to_string(whats_new) {
        let _ = std::fs::write(path, json);
    }
}

/// Tunnels that are up now, reconnected by `connect_on_launch` next launch.
fn save_resume(app: &AppHandle) {
    let running = app.state::<AppState>().running_ids();
    if let Some(path) = data_file(app, "resume.json") {
        let _ = std::fs::write(path, serde_json::to_string(&running).unwrap_or_default());
    }
}

/// Installs the ready update and restarts into it, bringing the currently
/// running tunnels back afterwards.
pub fn install_and_restart(app: &AppHandle) -> Result<(), String> {
    if is_simulated_ready(app) {
        // Everything a real update does around the install, minus the install:
        // the next launch resumes tunnels and shows "What's new".
        save_resume(app);
        write_whats_new(app, &WhatsNew {
            version: app.package_info().version.to_string(),
            notes: SAMPLE_NOTES.to_string(),
        });
        app.restart();
    }
    let (update, bytes) = take_ready(app).ok_or("No update is ready to install")?;
    save_resume(app);
    save_whats_new(app, &update);
    // On Windows this hands over to the installer, which closes this process
    // (after `before_windows_install`) and starts the new version itself.
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}

/// Called from `RunEvent::Exit`: on AppImage builds a ready update is applied
/// as the app quits, the way browsers do.
pub fn install_on_exit(app: &AppHandle) {
    if cfg!(windows) {
        return;
    }
    if let Some((update, bytes)) = take_ready(app) {
        save_whats_new(app, &update);
        let _ = update.install(bytes);
    }
}

/// The Windows installer ends this process with `std::process::exit`, which
/// skips `RunEvent::Exit`; the system proxy must still be restored.
fn before_windows_install(app: &AppHandle) -> impl Fn() + Send + Sync + 'static {
    let app = app.clone();
    move || {
        app.state::<AppState>().terminals.close_all();
        crate::router::system_proxy::cleanup_on_exit(&app);
    }
}

/// This launch is the restart into a just-installed update (its notes are
/// still waiting). Read without consuming them, for `setup`.
///
/// The relaunch carries the old process's arguments (the Windows installer
/// gets them as `/ARGS`, `app.restart()` reuses them), so an instance started
/// at sign-in comes back with `AUTOSTART_ARG`; with "start minimized" on it
/// would come back hidden in the tray and the update would look like it did
/// nothing.
pub fn just_updated(app: &AppHandle) -> bool {
    let Some(path) = data_file(app, "whats_new.json") else { return false };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|json| serde_json::from_str::<WhatsNew>(&json).ok())
        .is_some_and(|w| w.version == app.package_info().version.to_string())
}

/// Release notes left by the update that installed this version, once.
pub fn take_whats_new(app: &AppHandle) -> Option<WhatsNew> {
    let path = data_file(app, "whats_new.json")?;
    let json = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    let whats_new: WhatsNew = serde_json::from_str(&json).ok()?;
    (whats_new.version == app.package_info().version.to_string()).then_some(whats_new)
}

/// Connects the tunnels marked "connect on startup", plus the ones that were
/// up when the app restarted to update.
pub fn connect_on_launch(app: &AppHandle) {
    let mut ids: Vec<Uuid> = Vec::new();
    if let Some(path) = data_file(app, "resume.json") {
        if let Ok(json) = std::fs::read_to_string(&path) {
            ids = serde_json::from_str(&json).unwrap_or_default();
        }
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(tunnels) = app.state::<AppState>().db.list() {
        for tunnel in tunnels {
            if tunnel.auto_connect && !ids.contains(&tunnel.id) {
                ids.push(tunnel.id);
            }
        }
    }
    if ids.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for id in ids {
            let state = app.state::<AppState>();
            // A jump child connects its parent first; skip what's already up.
            if !state.is_connected(id) {
                let _ = crate::commands::connect_one(&app, &state, id).await;
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Developer tools: drive the update UI without a release to update to.

const SAMPLE_NOTES: &str = "## Simulated update\n\n\
- **Simple mode** for people who only browse through tunnels\n\
- One `Internal network` switch\n\
- This text comes from the developer tools, not a real release";

fn is_simulated_ready(app: &AppHandle) -> bool {
    let updates = app.state::<Updates>();
    let inner = updates.0.lock().unwrap();
    inner.simulated && inner.snapshot.phase == UpdatePhase::Ready
}

/// About three seconds of progress, then ready.
async fn fake_download(app: &AppHandle) {
    let updates = app.state::<Updates>();
    for step in 1..=20 {
        tokio::time::sleep(Duration::from_millis(150)).await;
        updates.set(app, |s| s.progress = Some(step as f32 / 20.0));
    }
    mark_ready(app);
    updates.0.lock().unwrap().busy = false;
}

/// `step`: "available" (as a background check finding the next patch
/// version, then downloading it when automatic updates are on), "error"
/// (a failed manual check) or "reset".
pub async fn simulate(app: &AppHandle, step: &str) -> Result<UpdateSnapshot, String> {
    let updates = app.state::<Updates>();
    match step {
        "available" => {
            let mut version = app.package_info().version.clone();
            version.patch += 1;
            {
                let mut inner = updates.0.lock().unwrap();
                if inner.busy {
                    return Err("a check or download is already running".into());
                }
                *inner = Inner { simulated: true, ..Inner::default() };
            }
            updates.set(app, |s| {
                *s = UpdateSnapshot {
                    phase: UpdatePhase::Available,
                    version: Some(version.to_string()),
                    notes: Some(SAMPLE_NOTES.to_string()),
                    last_checked: Some(now()),
                    ..UpdateSnapshot::default()
                };
            });
            crate::tray::rebuild_menu(app);
            if app.state::<AppState>().settings.get().auto_update {
                download(app).await;
            }
        }
        "error" => {
            updates.0.lock().unwrap().simulated = true;
            updates.set(app, |s| {
                s.phase = UpdatePhase::Error;
                s.error = Some("simulated: error sending request for url (https://github.com/...)".into());
                s.progress = None;
            });
        }
        "reset" => {
            *updates.0.lock().unwrap() = Inner::default();
            updates.set(app, |s| *s = UpdateSnapshot::default());
            crate::tray::rebuild_menu(app);
        }
        other => return Err(format!("unknown step {other}")),
    }
    Ok(updates.snapshot())
}

/// "What's new" for the running version, as if it had just been installed.
pub fn simulate_whats_new(app: &AppHandle) -> WhatsNew {
    WhatsNew {
        version: app.package_info().version.to_string(),
        notes: SAMPLE_NOTES.to_string(),
    }
}
