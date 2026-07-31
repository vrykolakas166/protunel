use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::db::{Tunnel, TunnelInput};
use crate::secrets;
use crate::settings::Settings;
use crate::tunnel::TunnelHandle;
use crate::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    pub key_id: String,
    pub fingerprint: String,
    pub algorithm: String,
    pub trusted_at: u64,
}

#[tauri::command]
pub fn list_tunnels(state: State<AppState>) -> Result<Vec<Tunnel>, String> {
    state.db.list().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_tunnel(
    app: AppHandle,
    state: State<AppState>,
    input: TunnelInput,
    secret: Option<String>,
) -> Result<Tunnel, String> {
    let tunnel = Tunnel {
        id: Uuid::new_v4(),
        name: input.name,
        host: input.host,
        port: input.port,
        username: input.username,
        auth: input.auth,
        local_socks_port: input.local_socks_port,
        auto_connect: input.auto_connect,
    };
    state.db.insert(&tunnel).map_err(|e| e.to_string())?;
    if let Some(secret) = secret {
        secrets::set_secret(tunnel.id, &secret).map_err(|e| e.to_string())?;
    }
    crate::tray::rebuild_menu(&app);
    Ok(tunnel)
}

#[tauri::command]
pub fn update_tunnel(
    app: AppHandle,
    state: State<AppState>,
    id: Uuid,
    input: TunnelInput,
    secret: Option<String>,
) -> Result<Tunnel, String> {
    let tunnel = Tunnel {
        id,
        name: input.name,
        host: input.host,
        port: input.port,
        username: input.username,
        auth: input.auth,
        local_socks_port: input.local_socks_port,
        auto_connect: input.auto_connect,
    };
    state.db.update(&tunnel).map_err(|e| e.to_string())?;
    if let Some(secret) = secret {
        secrets::set_secret(tunnel.id, &secret).map_err(|e| e.to_string())?;
    }
    crate::tray::rebuild_menu(&app);
    Ok(tunnel)
}

#[tauri::command]
pub fn delete_tunnel(app: AppHandle, state: State<AppState>, id: Uuid) -> Result<(), String> {
    state.stop(id);
    state.db.delete(id).map_err(|e| e.to_string())?;
    let _ = secrets::delete_secret(id);
    crate::tray::rebuild_menu(&app);
    Ok(())
}

async fn connect_one(app: &AppHandle, state: &State<'_, AppState>, id: Uuid) -> Result<(), String> {
    if state.is_connected(id) {
        return Ok(());
    }

    let tunnel = state
        .db
        .get(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "tunnel not found".to_string())?;
    let secret = secrets::get_secret(id).map_err(|e| e.to_string())?;

    let token = CancellationToken::new();
    let bytes_up = Arc::new(AtomicU64::new(0));
    let bytes_down = Arc::new(AtomicU64::new(0));
    state.start(
        id,
        TunnelHandle {
            cancel: token.clone(),
            bytes_up: bytes_up.clone(),
            bytes_down: bytes_down.clone(),
        },
    );

    let known_hosts = state.known_hosts.clone();
    let pending = state.pending_host_key.clone();
    let app_task = app.clone();

    tokio::spawn(async move {
        crate::ssh::run_tunnel(
            app_task.clone(),
            tunnel,
            secret,
            known_hosts,
            pending,
            token,
            bytes_up,
            bytes_down,
        )
        .await;
        app_task.state::<AppState>().clear(id);
        crate::tray::rebuild_menu(&app_task);
    });

    Ok(())
}

#[tauri::command]
pub async fn connect_tunnel(app: AppHandle, state: State<'_, AppState>, id: Uuid) -> Result<(), String> {
    connect_one(&app, &state, id).await
}

#[tauri::command]
pub fn disconnect_tunnel(state: State<AppState>, id: Uuid) -> Result<(), String> {
    state.stop(id);
    Ok(())
}

#[tauri::command]
pub async fn connect_all(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let tunnels = state.db.list().map_err(|e| e.to_string())?;
    let mut errors = Vec::new();
    for tunnel in tunnels {
        if let Err(e) = connect_one(&app, &state, tunnel.id).await {
            errors.push(format!("{}: {e}", tunnel.name));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[tauri::command]
pub fn disconnect_all(state: State<AppState>) -> Result<(), String> {
    for tunnel in state.db.list().map_err(|e| e.to_string())? {
        state.stop(tunnel.id);
    }
    Ok(())
}

#[tauri::command]
pub fn confirm_host_key(state: State<AppState>, request_id: Uuid) -> Result<(), String> {
    state.pending_host_key.resolve(request_id, true);
    Ok(())
}

#[tauri::command]
pub fn reject_host_key(state: State<AppState>, request_id: Uuid) -> Result<(), String> {
    state.pending_host_key.resolve(request_id, false);
    Ok(())
}

#[tauri::command]
pub fn list_known_hosts(state: State<AppState>) -> Vec<KnownHostEntry> {
    state
        .known_hosts
        .list()
        .into_iter()
        .map(|(key_id, key)| KnownHostEntry {
            key_id,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
            trusted_at: key.trusted_at,
        })
        .collect()
}

#[tauri::command]
pub fn forget_known_host(state: State<AppState>, key_id: String) {
    state.known_hosts.forget(&key_id);
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Settings {
    state.settings.get()
}

#[tauri::command]
pub fn update_settings(app: AppHandle, state: State<AppState>, settings: Settings) -> Result<Settings, String> {
    // Only touch the registry when the autostart flag actually changes — calling
    // disable() when it's already disabled fails with "file not found" on Windows.
    let currently_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    if settings.autostart_enabled != currently_enabled {
        if settings.autostart_enabled {
            app.autolaunch().enable().map_err(|e| e.to_string())?;
        } else {
            app.autolaunch().disable().map_err(|e| e.to_string())?;
        }
    }
    state.settings.update(settings.clone());
    Ok(settings)
}
