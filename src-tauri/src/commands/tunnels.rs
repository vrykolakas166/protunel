//! Tunnel CRUD and live port-forward edits.

use tauri::{AppHandle, State};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::db::{PortForward, PortForwardInput, Tunnel, TunnelInput};
use crate::events::StatusEvent;
use crate::secrets;
use crate::tunnel::ForwardCommand;
use crate::AppState;

use super::*;

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
        group: crate::db::clean_group(input.group),
        bookmarks: Vec::new(),
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
        group: crate::db::clean_group(input.group),
        bookmarks: Vec::new(),
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

/// Files hosts under a group (a blank or missing name ungroups them): the
/// group header's Rename / Ungroup. Only the group changes, so running
/// tunnels and open shells are untouched.
#[tauri::command]
pub fn set_tunnels_group(
    app: AppHandle,
    state: State<AppState>,
    ids: Vec<Uuid>,
    group: Option<String>,
) -> Result<(), String> {
    let group = crate::db::clean_group(group);
    state.db.set_group(&ids, group.as_deref()).map_err(|e| e.to_string())?;
    tunnels_changed(&app);
    Ok(())
}

/// Bookmarks kept per host, at most.
const MAX_BOOKMARKS: usize = 100;

/// Adds or removes one of a host's bookmarked folders (file panel). Saved
/// with the host, so config export carries them; never restarts a tunnel.
#[tauri::command]
pub fn edit_tunnel_bookmark(
    app: AppHandle,
    state: State<AppState>,
    id: Uuid,
    path: String,
    add: bool,
) -> Result<(), String> {
    // Kept exactly as given (a folder name may end in a space).
    if path.is_empty() || path.contains('\0') {
        return Err("invalid-path".into());
    }
    if !state.db.edit_bookmark(id, &path, add, MAX_BOOKMARKS).map_err(|e| e.to_string())? {
        return Err("too-many-bookmarks".into());
    }
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
pub async fn delete_port_forward(state: State<'_, AppState>, id: Uuid) -> Result<(), String> {
    let existing = state.db.get_forward(id).map_err(|e| e.to_string())?;
    state.db.delete_forward(id).map_err(|e| e.to_string())?;

    if let Some(existing) = existing {
        apply_forward_command(&state, existing.tunnel_id, |resp| ForwardCommand::Remove(id, resp))
            .await?;
    }
    Ok(())
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
            group: None,
            bookmarks: Vec::new(),
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
