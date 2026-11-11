use std::collections::HashSet;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::capture::{self, CapturedProcess};
use crate::db::{PortForward, PortForwardInput, Tunnel, TunnelInput};
use crate::events::{
    StatusEvent, HOST_KEY_RESOLVED_EVENT, SETTINGS_CHANGED_EVENT, TUNNELS_CHANGED_EVENT,
};
use crate::router::rules::{self, RouterRule, RouterRuleInput};
use crate::router::RoutingDecision;
use crate::secrets;
use crate::ssh::terminal::{self, TerminalExit, TerminalInput};
use crate::settings::{RouterConfig, Settings};
use crate::tunnel::{ForwardCommand, TunnelHandle};
use crate::AppState;

/// Label of the terminal window; `lib.rs` tears its terminals down on destroy.
pub const TERMINAL_WINDOW: &str = "terminal";

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

/// Current status of every tunnel the backend has run this session. Status is
/// pushed as events, so the frontend needs this to seed itself on load (or after
/// a webview reload) instead of showing everything as disconnected.
#[tauri::command]
pub fn list_tunnel_statuses(state: State<AppState>) -> Vec<StatusEvent> {
    state.statuses()
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
    tunnels_changed(&app);
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
    tunnels_changed(&app);
    Ok(tunnel)
}

#[tauri::command]
pub fn delete_tunnel(app: AppHandle, state: State<AppState>, id: Uuid) -> Result<(), String> {
    state.stop(id);
    state.forget_status(id);
    state.db.delete(id).map_err(|e| e.to_string())?;
    // Rules pointing at a tunnel that no longer exists would otherwise fall
    // through to the default action — silently sending prod traffic direct.
    state.db.orphan_router_rules(id).map_err(|e| e.to_string())?;
    let _ = state.router.reload_rules(&state.db);
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

/// Rebuilds the tray and tells every window to reload its tunnel list. Call
/// after any change to the set of tunnels or their names/hosts.
pub fn tunnels_changed(app: &AppHandle) {
    crate::tray::rebuild_menu(app);
    let _ = app.emit(TUNNELS_CHANGED_EVENT, ());
}

/// Shows the terminal window, creating it on first use. Async on purpose:
/// building a window from a sync command deadlocks on Windows.
#[tauri::command]
pub async fn open_terminal_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(TERMINAL_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, TERMINAL_WINDOW, WebviewUrl::App("terminal.html".into()))
        .title("protunel — Terminal")
        .inner_size(1180.0, 740.0)
        .min_inner_size(640.0, 400.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn terminal_open(
    app: AppHandle,
    state: State<'_, AppState>,
    tunnel_id: Uuid,
    cols: u32,
    rows: u32,
    on_output: Channel<InvokeResponseBody>,
    on_exit: Channel<TerminalExit>,
) -> Result<Uuid, String> {
    terminal::open(&app, &state, tunnel_id, cols, rows, on_output, on_exit).await
}

#[tauri::command]
pub fn terminal_write(state: State<AppState>, id: Uuid, data: String) -> Result<(), String> {
    state.terminals.send(id, TerminalInput::Data(data.into_bytes()))
}

#[tauri::command]
pub fn terminal_write_many(state: State<AppState>, ids: Vec<Uuid>, data: String) -> Result<(), String> {
    state.terminals.send_many(&ids, data.as_bytes())
}

#[tauri::command]
pub fn terminal_resize(state: State<AppState>, id: Uuid, cols: u32, rows: u32) -> Result<(), String> {
    state.terminals.send(id, TerminalInput::Resize { cols, rows })
}

#[tauri::command]
pub fn terminal_close(state: State<AppState>, id: Uuid) -> Result<(), String> {
    // Already gone (shell exited first) is the outcome the caller wanted.
    let _ = state.terminals.send(id, TerminalInput::Close);
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterSnapshot {
    pub running: bool,
    pub port: Option<u16>,
    /// Where the PAC script is served, when the system proxy is being driven.
    pub pac_url: Option<String>,
    /// Rules dropped from the active set because their pattern no longer compiles.
    pub compile_errors: Vec<String>,
}

#[tauri::command]
pub fn get_router_config(state: State<AppState>) -> RouterConfig {
    state.router.config()
}

#[tauri::command]
pub fn router_snapshot(state: State<AppState>) -> RouterSnapshot {
    RouterSnapshot {
        running: state.router.running_port().is_some(),
        port: state.router.running_port(),
        pac_url: state.router.pac_url(),
        compile_errors: state.router.compile_errors(),
    }
}

/// Saves router config and reconciles the live listener with it. A port, bypass
/// list, or system-proxy change needs a full restart; a default-action change
/// does not.
#[tauri::command]
pub async fn update_router_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: RouterConfig,
) -> Result<RouterConfig, String> {
    let previous = state.router.config();
    let needs_restart = previous.set_system_proxy != config.set_system_proxy
        || previous.bypass_list != config.bypass_list
        || previous.port != config.port;

    state.router.store.update(config.clone());

    let result = if config.enabled {
        if state.router.running_port().is_none() {
            crate::router::start(&app).await
        } else {
            crate::router::apply_change(&app, needs_restart).await
        }
    } else {
        crate::router::stop(&app).await;
        Ok(())
    };

    // A failed start must not leave the stored config claiming the router is on,
    // or the UI shows a running router that isn't listening.
    if let Err(e) = result {
        state.router.store.update(RouterConfig {
            enabled: false,
            ..config
        });
        return Err(e);
    }
    Ok(state.router.config())
}

#[tauri::command]
pub fn list_router_rules(state: State<AppState>) -> Result<Vec<RouterRule>, String> {
    state.db.list_router_rules().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_router_rule(
    app: AppHandle,
    state: State<'_, AppState>,
    input: RouterRuleInput,
) -> Result<RouterRule, String> {
    rules::validate(&input)?;
    let rule = RouterRule {
        id: Uuid::new_v4(),
        position: state.db.next_rule_position().map_err(|e| e.to_string())?,
        enabled: input.enabled,
        kind: input.kind,
        pattern: input.pattern,
        port: input.port,
        action: input.action,
        target_tunnel_id: input.target_tunnel_id,
    };
    state.db.insert_router_rule(&rule).map_err(|e| e.to_string())?;
    crate::router::apply_change(&app, false).await?;
    Ok(rule)
}

#[tauri::command]
pub async fn update_router_rule(
    app: AppHandle,
    state: State<'_, AppState>,
    id: Uuid,
    input: RouterRuleInput,
) -> Result<RouterRule, String> {
    rules::validate(&input)?;
    let existing = state
        .db
        .get_router_rule(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "router rule not found".to_string())?;
    let rule = RouterRule {
        id,
        position: existing.position,
        enabled: input.enabled,
        kind: input.kind,
        pattern: input.pattern,
        port: input.port,
        action: input.action,
        target_tunnel_id: input.target_tunnel_id,
    };
    state.db.update_router_rule(&rule).map_err(|e| e.to_string())?;
    crate::router::apply_change(&app, false).await?;
    Ok(rule)
}

#[tauri::command]
pub async fn delete_router_rule(
    app: AppHandle,
    state: State<'_, AppState>,
    id: Uuid,
) -> Result<(), String> {
    state.db.delete_router_rule(id).map_err(|e| e.to_string())?;
    crate::router::apply_change(&app, false).await
}

#[tauri::command]
pub async fn reorder_router_rules(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<Uuid>,
) -> Result<(), String> {
    state.db.reorder_router_rules(&ids).map_err(|e| e.to_string())?;
    crate::router::apply_change(&app, false).await
}

#[tauri::command]
pub fn list_router_decisions(state: State<AppState>) -> Vec<RoutingDecision> {
    state.router.decisions()
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Settings {
    state.settings.get()
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
pub fn update_settings(app: AppHandle, state: State<AppState>, settings: Settings) -> Result<Settings, String> {
    sync_autostart(&app, settings.autostart_enabled)?;
    state.settings.update(settings.clone());
    Ok(settings)
}

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
