//! Trusted host keys (TOFU) and refused ones.

use serde::Serialize;
use tauri::State;

use crate::ssh::known_hosts;
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

/// Hosts whose server offered a different key than the trusted one since the
/// app started. Seeds a reloaded webview; live ones arrive as events.
#[tauri::command]
pub fn list_host_key_mismatches(state: State<AppState>) -> Vec<known_hosts::HostKeyMismatch> {
    state.known_hosts.mismatches()
}
