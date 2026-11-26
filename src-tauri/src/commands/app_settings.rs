//! Settings, autostart, and the Simple-mode network switch.

use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_autostart::ManagerExt;

use crate::events::SETTINGS_CHANGED_EVENT;
use crate::settings::Settings;
use crate::AppState;

/// Quits protunel, as the tray's Exit (the same `RunEvent::Exit` cleanup).
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Settings {
    state.settings.get()
}

/// Passed by the OS autostart entry, so a sign-in launch can be told apart
/// from the user opening the app.
pub const AUTOSTART_ARG: &str = "--autostart";

/// Rewrites an enabled autostart entry with the current arguments.
pub fn refresh_autostart(app: &AppHandle) {
    let launcher = app.autolaunch();
    if launcher.is_enabled().unwrap_or(false) {
        let _ = launcher.disable();
        let _ = launcher.enable();
    }
}

/// Brings the autostart registry entry in line with `enabled`.
///
/// Only touches the registry when the flag actually changes — calling
/// `disable()` when it is already disabled fails with "file not found" on
/// Windows. Shared with config import, which sets the same flag.
pub fn sync_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let currently_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    if enabled == currently_enabled {
        return Ok(());
    }
    if enabled {
        app.autolaunch().enable().map_err(|e| e.to_string())
    } else {
        app.autolaunch().disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn update_settings(app: AppHandle, state: State<AppState>, patch: Map<String, Value>) -> Result<Settings, String> {
    let settings = state.settings.apply_patch(patch, |settings| {
        sync_autostart(&app, settings.autostart_enabled)
    })?;
    let _ = app.emit(SETTINGS_CHANGED_EVENT, &settings);
    // The tray menu differs between Simple and Full mode.
    crate::tray::rebuild_menu(&app);
    Ok(settings)
}

/// The Simple-mode "internal network" switch (see `access.rs`).
#[tauri::command]
pub async fn set_network_access(app: AppHandle, on: bool) -> Result<(), String> {
    crate::access::set(&app, on).await
}

// ---------------------------------------------------------------------------
// Developer tools: buttons that fake update states and tunnel failures, for
// testing the UI without a release or a broken server. Debug builds, or a
// release started with PROTUNEL_DEVTOOLS=1.
