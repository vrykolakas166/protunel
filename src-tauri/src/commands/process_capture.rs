//! Launching apps with their traffic routed through the router (Windows).

use serde::Deserialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::capture::{self, CapturedProcess};
use crate::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchCaptureInput {
    pub exe_path: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub label: Option<String>,
}

#[tauri::command]
pub async fn pick_capture_target(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Executables", &["exe"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });

    let Some(path) = rx.await.map_err(|_| "file dialog closed".to_string())? else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| format!("unusable path: {e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Launches `input.exePath` with the capture hook injected, so its outbound
/// traffic lands on the router's SOCKS5 port. Re-validates the path
/// server-side rather than trusting whatever the frontend sent — the
/// frontend holds no source of truth here any more than anywhere else in
/// this app, and this command's blast radius (arbitrary code injection) is
/// larger than most.
#[tauri::command]
pub async fn launch_capture(
    app: AppHandle,
    state: State<'_, AppState>,
    input: LaunchCaptureInput,
) -> Result<CapturedProcess, String> {
    let exe = std::path::Path::new(&input.exe_path);
    let is_exe = exe
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("exe"));
    if !exe.is_file() || !is_exe {
        return Err("not a valid .exe path".to_string());
    }

    // Captured traffic is worthless without somewhere to send it — mirrors
    // update_router_config's existing start-if-needed behavior.
    if state.router.running_port().is_none() {
        crate::router::start(&app).await?;
    }
    let router_port = state
        .router
        .running_port()
        .ok_or_else(|| "router did not start".to_string())?;

    let hook_dll_path = app
        .path()
        .resolve("resources/capture_hook.dll", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("could not locate capture hook resource: {e}"))?;

    let launched =
        capture::inject::launch(&input.exe_path, &input.args, &hook_dll_path, router_port)?;
    state
        .capture
        .record_recent(input.exe_path.clone(), input.args.clone(), input.label.clone());
    let process = CapturedProcess::new(launched.pid, input.exe_path, input.label);
    state.capture.insert(process.clone());
    Ok(process)
}

#[tauri::command]
pub fn list_recent_captures(state: State<AppState>) -> Vec<crate::settings::RecentCapture> {
    state.capture.recent()
}

/// Always terminates the process — v1 has no live detach, since safely
/// un-hooking mid-flight is fragile and "Stop" reads as "kill" anyway.
#[tauri::command]
pub fn stop_capture(state: State<AppState>, id: Uuid) -> Result<(), String> {
    let Some(process) = state.capture.remove(id) else {
        return Ok(());
    };
    capture::inject::terminate(process.pid)
}

#[tauri::command]
pub fn list_active_captures(state: State<AppState>) -> Vec<CapturedProcess> {
    state.capture.list()
}

#[tauri::command]
pub fn list_capture_connections(state: State<AppState>) -> Vec<crate::capture::CaptureConnection> {
    state.capture.connections()
}
