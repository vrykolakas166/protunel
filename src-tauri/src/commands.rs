use std::collections::HashSet;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::db::{PortForward, PortForwardInput, Tunnel, TunnelInput};
use crate::secrets;
use crate::settings::Settings;
use crate::tunnel::{ForwardCommand, TunnelHandle};
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
        forwards: Vec::new(),
        jump_tunnel_id: input.jump_tunnel_id,
        socks_enabled: input.socks_enabled,
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
        forwards: Vec::new(),
        jump_tunnel_id: input.jump_tunnel_id,
        socks_enabled: input.socks_enabled,
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

/// Sends a forward control command to a running tunnel's task and awaits its
/// bind/teardown result. Returns `Ok(())` if the tunnel isn't currently running
/// (nothing to hot-apply — the change still applies on next connect) or if the
/// tunnel task ended mid-flight.
async fn apply_forward_command(
    state: &State<'_, AppState>,
    tunnel_id: Uuid,
    build: impl FnOnce(oneshot::Sender<Result<(), String>>) -> ForwardCommand,
) -> Result<(), String> {
    let Some(tx) = state.forward_sender(tunnel_id) else {
        return Ok(());
    };
    let (resp_tx, resp_rx) = oneshot::channel();
    if tx.send(build(resp_tx)).is_err() {
        return Ok(());
    }
    match resp_rx.await {
        Ok(result) => result,
        Err(_) => Ok(()),
    }
}

#[tauri::command]
pub async fn add_port_forward(
    state: State<'_, AppState>,
    tunnel_id: Uuid,
    input: PortForwardInput,
) -> Result<PortForward, String> {
    let forward = PortForward {
        id: Uuid::new_v4(),
        tunnel_id,
        remote_host: input.remote_host,
        remote_port: input.remote_port,
        local_port: input.local_port,
    };
    state.db.insert_forward(&forward).map_err(|e| e.to_string())?;

    let hot_forward = forward.clone();
    if let Err(e) =
        apply_forward_command(&state, tunnel_id, |resp| ForwardCommand::Add(hot_forward, resp)).await
    {
        let _ = state.db.delete_forward(forward.id);
        return Err(e);
    }

    Ok(forward)
}

#[tauri::command]
pub async fn update_port_forward(
    state: State<'_, AppState>,
    id: Uuid,
    input: PortForwardInput,
) -> Result<PortForward, String> {
    let existing = state
        .db
        .get_forward(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "port forward not found".to_string())?;
    let forward = PortForward {
        id,
        tunnel_id: existing.tunnel_id,
        remote_host: input.remote_host,
        remote_port: input.remote_port,
        local_port: input.local_port,
    };
    state.db.update_forward(&forward).map_err(|e| e.to_string())?;

    apply_forward_command(&state, forward.tunnel_id, |resp| ForwardCommand::Remove(id, resp)).await?;
    let hot_forward = forward.clone();
    apply_forward_command(&state, forward.tunnel_id, |resp| ForwardCommand::Add(hot_forward, resp))
        .await?;

    Ok(forward)
}

#[tauri::command]
pub async fn delete_port_forward(state: State<'_, AppState>, id: Uuid) -> Result<(), String> {
    let existing = state.db.get_forward(id).map_err(|e| e.to_string())?;
    state.db.delete_forward(id).map_err(|e| e.to_string())?;

    if let Some(existing) = existing {
        apply_forward_command(&state, existing.tunnel_id, |resp| ForwardCommand::Remove(id, resp))
            .await?;
    }
    Ok(())
}

/// Connects `id`, first auto-connecting any unconnected jump-tunnel chain it
/// depends on (outermost jump first). `connect_single` returns as soon as the
/// tunnel's task is *spawned*, not once its SSH session is authenticated, so each
/// hop but the last is awaited via `wait_for_session` before the next hop (which
/// needs a live session to open its jump channel through) is attempted.
async fn connect_one(app: &AppHandle, state: &State<'_, AppState>, id: Uuid) -> Result<(), String> {
    let mut chain = vec![id];
    let mut seen: HashSet<Uuid> = HashSet::new();
    seen.insert(id);
    let mut current = id;
    loop {
        if state.is_connected(current) {
            break;
        }
        let tunnel = state
            .db
            .get(current)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "tunnel not found".to_string())?;
        match tunnel.jump_tunnel_id {
            Some(jump_id) if !state.is_connected(jump_id) => {
                if !seen.insert(jump_id) {
                    return Err("jump tunnel chain has a cycle".to_string());
                }
                chain.push(jump_id);
                current = jump_id;
            }
            _ => break,
        }
    }

    let mut hops = chain.into_iter().rev().peekable();
    while let Some(hop_id) = hops.next() {
        connect_single(app, state, hop_id).await?;
        if hops.peek().is_some() {
            wait_for_session(state, hop_id, Duration::from_secs(20)).await?;
        }
    }

    Ok(())
}

/// Polls until a just-connected hop's SSH session is actually authenticated
/// (needed before the next hop can open a jump channel through it), or fails
/// fast if it disconnects/errors out in the meantime, or after `timeout`.
async fn wait_for_session(state: &State<'_, AppState>, id: Uuid, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if state.session_for(id).is_some() {
            return Ok(());
        }
        if !state.is_connected(id) {
            return Err("jump tunnel disconnected before it finished connecting".to_string());
        }
        if Instant::now() >= deadline {
            return Err("timed out waiting for jump tunnel to connect".to_string());
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

async fn connect_single(app: &AppHandle, state: &State<'_, AppState>, id: Uuid) -> Result<(), String> {
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
    let (forward_tx, forward_rx) = mpsc::unbounded_channel();
    let session_slot = Arc::new(Mutex::new(None));
    state.start(
        id,
        TunnelHandle {
            cancel: token.clone(),
            bytes_up: bytes_up.clone(),
            bytes_down: bytes_down.clone(),
            forward_tx,
            session: session_slot.clone(),
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
            forward_rx,
            session_slot,
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
