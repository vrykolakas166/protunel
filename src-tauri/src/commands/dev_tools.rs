
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::updates;
use crate::AppState;

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
