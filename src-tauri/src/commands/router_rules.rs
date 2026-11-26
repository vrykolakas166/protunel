//! The proxy router: config, rules and the decision log.

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::router::rules::{self, RouterRule, RouterRuleInput};
use crate::router::RoutingDecision;
use crate::settings::RouterConfig;
use crate::AppState;

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

    state.router.store.update(config.clone())?;

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
        state.router.store.update_or_log(RouterConfig {
            enabled: false,
            ..config
        });
        return Err(e);
    }
    Ok(state.router.config())
}

/// Turns the router on or off as its switch does (tray menu).
pub async fn set_router_enabled(app: &AppHandle, enabled: bool) -> Result<RouterConfig, String> {
    let state = app.state::<AppState>();
    let config = RouterConfig {
        enabled,
        ..state.router.config()
    };
    update_router_config(app.clone(), state, config).await
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
