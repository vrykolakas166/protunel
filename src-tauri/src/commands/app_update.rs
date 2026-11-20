//! In-app updates (the logic lives in `crate::updates`).

use tauri::{AppHandle, Manager};

use crate::updates;

#[tauri::command]
pub fn update_status(app: AppHandle) -> updates::UpdateSnapshot {
    app.state::<updates::Updates>().snapshot()
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> updates::UpdateSnapshot {
    updates::check(&app, true).await
}

#[tauri::command]
pub async fn download_update(app: AppHandle) -> updates::UpdateSnapshot {
    updates::download(&app).await
}

/// Installs the downloaded update and restarts; returns only on failure.
#[tauri::command]
pub fn install_update(app: AppHandle) -> Result<(), String> {
    updates::install_and_restart(&app)
}

#[tauri::command]
pub fn take_whats_new(app: AppHandle) -> Option<updates::WhatsNew> {
    updates::take_whats_new(&app)
}
