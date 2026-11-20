//! Connecting and disconnecting tunnels, jump chains included, and answering the host-key prompt.

use std::collections::HashSet;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::events::HOST_KEY_RESOLVED_EVENT;
use crate::secrets;
use crate::tunnel::TunnelHandle;
use crate::AppState;

/// Connects `id`, first auto-connecting any unconnected jump-tunnel chain it
/// depends on (outermost jump first). `connect_single` returns as soon as the
/// tunnel's task is *spawned*, not once its SSH session is authenticated, so each
/// hop but the last is awaited via `wait_for_session` before the next hop (which
/// needs a live session to open its jump channel through) is attempted.
pub async fn connect_one(app: &AppHandle, state: &AppState, id: Uuid) -> Result<(), String> {
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
pub async fn wait_for_session(state: &AppState, id: Uuid, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if state.session_for(id).is_some() {
            return Ok(());
        }
        if !state.is_connected(id) {
            return Err("tunnel disconnected before it finished connecting".to_string());
        }
        if Instant::now() >= deadline {
            return Err("timed out waiting for tunnel to connect".to_string());
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// Numbers each run of a tunnel; see `TunnelHandle::generation`.
static TUNNEL_GENERATION: AtomicU64 = AtomicU64::new(0);

async fn connect_single(app: &AppHandle, state: &AppState, id: Uuid) -> Result<(), String> {
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
    let (finished_tx, finished_rx) = tokio::sync::watch::channel(false);
    let generation = TUNNEL_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    state.start(
        id,
        TunnelHandle {
            cancel: token.clone(),
            bytes_up: bytes_up.clone(),
            bytes_down: bytes_down.clone(),
            forward_tx,
            session: session_slot.clone(),
            finished: finished_rx,
            generation,
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
        app_task.state::<AppState>().clear(id, generation);
        let _ = finished_tx.send(true);
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
pub fn confirm_host_key(app: AppHandle, state: State<AppState>, request_id: Uuid) -> Result<(), String> {
    state.pending_host_key.resolve(request_id, true);
    let _ = app.emit(HOST_KEY_RESOLVED_EVENT, request_id);
    Ok(())
}

#[tauri::command]
pub fn reject_host_key(app: AppHandle, state: State<AppState>, request_id: Uuid) -> Result<(), String> {
    state.pending_host_key.resolve(request_id, false);
    let _ = app.emit(HOST_KEY_RESOLVED_EVENT, request_id);
    Ok(())
}
