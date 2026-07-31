use tauri::{AppHandle, Manager, State};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::db::{Tunnel, TunnelInput};
use crate::secrets;
use crate::AppState;

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

#[tauri::command]
pub async fn connect_tunnel(app: AppHandle, state: State<'_, AppState>, id: Uuid) -> Result<(), String> {
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
    state.start(id, token.clone());

    let known_hosts = state.known_hosts.clone();
    let pending = state.pending_host_key.clone();
    let app_task = app.clone();

    tokio::spawn(async move {
        crate::ssh::run_tunnel(app_task.clone(), tunnel, secret, known_hosts, pending, token).await;
        app_task.state::<AppState>().clear(id);
        crate::tray::rebuild_menu(&app_task);
    });

    Ok(())
}

#[tauri::command]
pub fn disconnect_tunnel(state: State<AppState>, id: Uuid) -> Result<(), String> {
    state.stop(id);
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
