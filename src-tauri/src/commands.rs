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
use crate::ssh::known_hosts;
use crate::updates;
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

fn insert_tunnel(state: &AppState, input: TunnelInput, secret: Option<&str>) -> Result<Tunnel, String> {
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
        secrets::set_secret(tunnel.id, secret).map_err(|e| e.to_string())?;
    }
    Ok(tunnel)
}

/// The secret a new tunnel should get: the one typed in the form, otherwise a
/// copy of `copy_secret_from`'s (clone / bulk add). Copying happens here so
/// the stored password never has to cross the IPC boundary to the webview.
fn resolve_secret(secret: Option<String>, copy_secret_from: Option<Uuid>) -> Result<Option<String>, String> {
    match (secret, copy_secret_from) {
        (Some(secret), _) => Ok(Some(secret)),
        (None, Some(source)) => secrets::get_secret(source).map_err(|e| e.to_string()),
        (None, None) => Ok(None),
    }
}

#[tauri::command]
pub fn add_tunnel(
    app: AppHandle,
    state: State<AppState>,
    input: TunnelInput,
    secret: Option<String>,
    copy_secret_from: Option<Uuid>,
) -> Result<Tunnel, String> {
    let secret = resolve_secret(secret, copy_secret_from)?;
    let tunnel = insert_tunnel(&state, input, secret.as_deref())?;
    tunnels_changed(&app);
    Ok(tunnel)
}

/// Upper bound for one bulk add; a typo like 10.0.0.1-10.0.255.255 should be
/// refused, not turned into 65k tunnels and vault entries.
const MAX_BULK_TUNNELS: usize = 256;

/// Adds several tunnels that share one secret (an address range from the add
/// form). One `tunnels-changed` at the end instead of one per tunnel.
#[tauri::command]
pub fn add_tunnels(
    app: AppHandle,
    state: State<AppState>,
    inputs: Vec<TunnelInput>,
    secret: Option<String>,
    copy_secret_from: Option<Uuid>,
) -> Result<Vec<Tunnel>, String> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    if inputs.len() > MAX_BULK_TUNNELS {
        return Err(format!("At most {MAX_BULK_TUNNELS} tunnels can be added at once"));
    }
    let secret = resolve_secret(secret, copy_secret_from)?;
    let mut created = Vec::with_capacity(inputs.len());
    let mut failure = None;
    for input in inputs {
        match insert_tunnel(&state, input, secret.as_deref()) {
            Ok(tunnel) => created.push(tunnel),
            Err(e) => {
                failure = Some(e);
                break;
            }
        }
    }
    // Whatever made it in must show up, even if a later insert failed.
    tunnels_changed(&app);
    match failure {
        Some(e) => Err(format!("Added {} tunnels, then failed: {e}", created.len())),
        None => Ok(created),
    }
}

/// Whether moving from `old` to `new` needs a new SSH session (or new local
/// listeners). A rename or the startup flag does not.
fn needs_reconnect(old: &Tunnel, new: &Tunnel) -> bool {
    old.host != new.host
        || old.port != new.port
        || old.username != new.username
        || old.auth != new.auth
        || old.jump_tunnel_id != new.jump_tunnel_id
        || old.socks_enabled != new.socks_enabled
        || (new.socks_enabled && old.local_socks_port != new.local_socks_port)
}

/// Saves a tunnel. If it is running and the change affects its connection,
/// it is restarted on the spot ("apply & restart"): sessions riding on it —
/// terminals, tunnels jumping through it — drop and reconnect to the new
/// settings. Otherwise a running tunnel would keep using what it was started
/// with until someone toggled it by hand.
#[tauri::command]
pub async fn update_tunnel(
    app: AppHandle,
    state: State<'_, AppState>,
    id: Uuid,
    input: TunnelInput,
    secret: Option<String>,
) -> Result<Tunnel, String> {
    let previous = state.db.get(id).map_err(|e| e.to_string())?;
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
    let secret_changed = secret.is_some();
    if let Some(secret) = secret {
        secrets::set_secret(tunnel.id, &secret).map_err(|e| e.to_string())?;
    }
    tunnels_changed(&app);

    let changed = secret_changed || previous.is_some_and(|old| needs_reconnect(&old, &tunnel));
    if changed && state.is_connected(id) {
        state.stop_and_wait(id).await;
        // The save itself succeeded; a failed reconnect shows on the tunnel.
        let _ = connect_one(&app, &state, id).await;
        crate::tray::rebuild_menu(&app);
    }
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
    tunnels_changed(&app);
    Ok(())
}

/// Saves the display order of tunnels (drag-and-drop in either window).
#[tauri::command]
pub fn reorder_tunnels(app: AppHandle, state: State<AppState>, ids: Vec<Uuid>) -> Result<(), String> {
    state.db.reorder_tunnels(&ids).map_err(|e| e.to_string())?;
    tunnels_changed(&app);
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

/// Rebuilds the tray and tells every window to reload its tunnel list. Call
/// after any change to the set of tunnels or their names/hosts.
pub fn tunnels_changed(app: &AppHandle) {
    crate::tray::rebuild_menu(app);
    let _ = app.emit(TUNNELS_CHANGED_EVENT, ());
}

/// Shows the terminal window, creating it on first use. Async on purpose:
/// building a window from a sync command deadlocks on Windows.
/// How long a closed (hidden) terminal window is kept for a quick reopen
/// before its webview is destroyed to give the memory back.
const TERMINAL_KEEP_HIDDEN: std::time::Duration = std::time::Duration::from_secs(60);

/// Bumped on every hide and every open; a pending teardown only runs if it is
/// still the latest thing that happened to the window.
static TERMINAL_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Destroys the hidden terminal window after `TERMINAL_KEEP_HIDDEN`, unless
/// it was reopened in the meantime.
pub fn schedule_terminal_teardown(app: &AppHandle) {
    use std::sync::atomic::Ordering;
    let generation = TERMINAL_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(TERMINAL_KEEP_HIDDEN).await;
        if TERMINAL_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Some(window) = app.get_webview_window(TERMINAL_WINDOW) {
            if !window.is_visible().unwrap_or(true) {
                let _ = window.destroy();
            }
        }
    });
}

#[tauri::command]
pub async fn open_terminal_window(app: AppHandle) -> Result<(), String> {
    // Cancels a pending teardown of the hidden window.
    TERMINAL_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(TERMINAL_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let built = WebviewWindowBuilder::new(&app, TERMINAL_WINDOW, WebviewUrl::App("terminal.html".into()))
        .title("protunel — Terminal")
        .inner_size(1180.0, 740.0)
        .min_inner_size(640.0, 400.0)
        .build();
    match built {
        Ok(window) => harden_webview(&window),
        // Two quick clicks both found no window and both tried to build it;
        // the one that lost just shows the winner's.
        Err(e) => {
            let window = app.get_webview_window(TERMINAL_WINDOW).ok_or_else(|| e.to_string())?;
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    Ok(())
}

/// Turns off WebView2's browser shortcuts (F5/Ctrl+R reload, Ctrl+F find,
/// Ctrl+P print, F7 caret browsing, Ctrl+Shift+I…) so a keystroke can never
/// reach the browser instead of the app — a reload would drop every open
/// shell. Release builds only: in development reload and devtools are wanted.
/// WebKitGTK has no such built-in shortcuts; the terminal page also cancels
/// stray keys itself on every platform.
pub fn harden_webview(window: &tauri::WebviewWindow) {
    #[cfg(all(windows, not(debug_assertions)))]
    {
        let _ = window.with_webview(|webview| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
            use windows_core::Interface;
            let Ok(core) = webview.controller().CoreWebView2() else { return };
            let Ok(settings) = core.Settings() else { return };
            if let Ok(settings) = settings.cast::<ICoreWebView2Settings3>() {
                let _ = settings.SetAreBrowserAcceleratorKeysEnabled(false);
            }
        });
    }
    #[cfg(not(all(windows, not(debug_assertions))))]
    let _ = window;
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

/// The Simple-mode "internal network" switch (see `access.rs`).
#[tauri::command]
pub async fn set_network_access(app: AppHandle, on: bool) -> Result<(), String> {
    crate::access::set(&app, on).await
}

// ---------------------------------------------------------------------------
// Developer tools: buttons that fake update states and tunnel failures, for
// testing the UI without a release or a broken server. Debug builds, or a
// release started with PROTUNEL_DEVTOOLS=1.

#[tauri::command]
pub fn dev_tools_enabled() -> bool {
    cfg!(debug_assertions) || std::env::var("PROTUNEL_DEVTOOLS").is_ok_and(|v| v == "1")
}

fn require_dev_tools() -> Result<(), String> {
    if dev_tools_enabled() {
        Ok(())
    } else {
        Err("developer tools are off in this build".into())
    }
}

#[tauri::command]
pub async fn debug_simulate_update(app: AppHandle, step: String) -> Result<updates::UpdateSnapshot, String> {
    require_dev_tools()?;
    updates::simulate(&app, &step).await
}

#[tauri::command]
pub fn debug_whats_new(app: AppHandle) -> Result<updates::WhatsNew, String> {
    require_dev_tools()?;
    Ok(updates::simulate_whats_new(&app))
}

/// Puts a tunnel into a failed state as if connecting had just failed.
/// `kind`: "auth" (wrong password), "unreachable" or "hostKey" (changed key).
#[tauri::command]
pub async fn debug_fail_tunnel(
    app: AppHandle,
    state: State<'_, AppState>,
    id: Uuid,
    kind: String,
) -> Result<(), String> {
    require_dev_tools()?;
    let tunnel = state.db.get(id).map_err(|e| e.to_string())?.ok_or("no such tunnel")?;
    // A live task would overwrite the fake status with its own.
    state.stop_and_wait(id).await;
    let message = match kind.as_str() {
        "auth" => "password authentication failed: simulated".to_string(),
        "unreachable" => format!(
            "failed to connect to {}:{}: Connection timed out (os error 110)",
            tunnel.host, tunnel.port
        ),
        "hostKey" => {
            let key_id = format!("{}:{}", tunnel.host, tunnel.port);
            let mismatch = state.known_hosts.record_fake_mismatch(&key_id);
            let _ = app.emit(crate::events::HOST_KEY_MISMATCH_EVENT, mismatch);
            "Unknown server key".to_string()
        }
        other => return Err(format!("unknown failure {other}")),
    };
    crate::ssh::emit_status(&app, id, &tunnel.name, crate::events::TunnelStatus::Error, Some(message));
    Ok(())
}

/// Hosts whose server offered a different key than the trusted one since the
/// app started. Seeds a reloaded webview; live ones arrive as events.
#[tauri::command]
pub fn list_host_key_mismatches(state: State<AppState>) -> Vec<known_hosts::HostKeyMismatch> {
    state.known_hosts.mismatches()
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
pub fn update_settings(app: AppHandle, state: State<AppState>, settings: Settings) -> Result<Settings, String> {
    sync_autostart(&app, settings.autostart_enabled)?;
    state.settings.update(settings.clone());
    let _ = app.emit(SETTINGS_CHANGED_EVENT, &settings);
    // The tray menu differs between Simple and Full mode.
    crate::tray::rebuild_menu(&app);
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

#[cfg(test)]
mod reconnect_tests {
    use super::needs_reconnect;
    use crate::db::{AuthMethod, Tunnel};
    use uuid::Uuid;

    fn tunnel() -> Tunnel {
        Tunnel {
            id: Uuid::nil(),
            name: "db".into(),
            host: "10.0.0.1".into(),
            port: 22,
            username: "root".into(),
            auth: AuthMethod::Password,
            local_socks_port: 1080,
            auto_connect: false,
            forwards: Vec::new(),
            jump_tunnel_id: None,
            socks_enabled: true,
        }
    }

    #[test]
    fn rename_and_startup_flag_keep_the_session() {
        let old = tunnel();
        let new = Tunnel { name: "renamed".into(), auto_connect: true, ..tunnel() };
        assert!(!needs_reconnect(&old, &new));
    }

    #[test]
    fn connection_fields_need_a_new_session() {
        let old = tunnel();
        for new in [
            Tunnel { host: "10.0.0.2".into(), ..tunnel() },
            Tunnel { port: 2222, ..tunnel() },
            Tunnel { username: "admin".into(), ..tunnel() },
            Tunnel { auth: AuthMethod::Agent, ..tunnel() },
            Tunnel { jump_tunnel_id: Some(Uuid::new_v4()), ..tunnel() },
            Tunnel { socks_enabled: false, ..tunnel() },
            Tunnel { local_socks_port: 1081, ..tunnel() },
        ] {
            assert!(needs_reconnect(&old, &new));
        }
    }

    #[test]
    fn socks_port_is_irrelevant_while_socks_is_off() {
        let old = Tunnel { socks_enabled: false, ..tunnel() };
        let new = Tunnel { socks_enabled: false, local_socks_port: 1090, ..tunnel() };
        assert!(!needs_reconnect(&old, &new));
    }
}
