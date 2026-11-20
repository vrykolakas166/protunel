//! "Internal network": the one switch Simple mode shows.
//!
//! On starts the router with the Windows system proxy pointed at it, so a
//! browser reaches internal sites with no setup of its own, and connects the
//! tunnels the router's rules send traffic to — the router would dial them on
//! the first request anyway, but connecting up front surfaces a wrong password
//! or an unreachable server while the user is looking. Off stops the router
//! (which restores the system proxy) and every tunnel.

use std::collections::HashSet;

use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::router::rules::RuleAction;
use crate::AppState;

/// Whether the switch reads "on": the router is listening.
pub fn is_on(app: &AppHandle) -> bool {
    app.try_state::<AppState>()
        .is_some_and(|state| state.router.running_port().is_some())
}

/// Tunnels that enabled rules (or the default action) route through.
fn routed_tunnels(state: &AppState) -> Vec<Uuid> {
    let config = state.router.config();
    let mut ids: Vec<Uuid> = Vec::new();
    let mut seen = HashSet::new();
    let rules = state.db.list_router_rules().unwrap_or_default();
    let from_rules = rules
        .iter()
        .filter(|rule| rule.enabled && rule.action == RuleAction::Tunnel)
        .filter_map(|rule| rule.target_tunnel_id);
    let from_default = (config.default_action == RuleAction::Tunnel)
        .then_some(config.default_tunnel_id)
        .flatten();
    for id in from_rules.chain(from_default) {
        if seen.insert(id) {
            ids.push(id);
        }
    }
    ids
}

/// Connects the routed tunnels one by one, in the background. Errors show up
/// on each tunnel's row through the usual status events.
pub fn connect_routed(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let ids = routed_tunnels(&app.state::<AppState>());
        for id in ids {
            let state = app.state::<AppState>();
            if !state.is_connected(id) {
                let _ = crate::commands::connect_one(&app, &state, id).await;
            }
        }
    });
}

pub async fn set(app: &AppHandle, on: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut config = state.router.config();
    config.enabled = on;
    if on {
        // Simple mode has no other way to point a browser at the router.
        config.set_system_proxy = true;
    }
    state.router.store.update(config.clone())?;

    if on {
        if let Err(e) = crate::router::start(app).await {
            // Already failing: the start error is the one worth reporting.
            state.router.store.update_or_log(crate::settings::RouterConfig { enabled: false, ..config });
            crate::tray::rebuild_menu(app);
            return Err(e);
        }
        connect_routed(app);
    } else {
        crate::router::stop(app).await;
        for tunnel in state.db.list().map_err(|e| e.to_string())? {
            state.stop(tunnel.id);
        }
    }
    crate::tray::rebuild_menu(app);
    Ok(())
}

/// The UI mode is Simple ("simple"); unset or "full" is the full app.
pub fn is_simple(app: &AppHandle) -> bool {
    app.try_state::<AppState>()
        .is_some_and(|state| state.settings.get().ui_mode.as_deref() == Some("simple"))
}
