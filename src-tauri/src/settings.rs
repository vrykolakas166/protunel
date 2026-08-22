use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use uuid::Uuid;

use crate::router::rules::RuleAction;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
    pub autostart_enabled: bool,
    pub port_range_min: u16,
    pub port_range_max: u16,
    #[serde(default = "default_notifications_enabled")]
    pub notifications_enabled: bool,
    /// Whether a tunnel that loses its SSH session (dead VPN, laptop sleep,
    /// server reboot) retries on its own instead of just going red.
    #[serde(default = "default_auto_reconnect_enabled")]
    pub auto_reconnect_enabled: bool,
    /// How long an idle session may go silent before we ping the server. Three
    /// unanswered pings tear the session down, which is what makes a dead peer
    /// detectable at all. `0` disables keepalives.
    #[serde(default = "default_keepalive_interval_secs")]
    pub keepalive_interval_secs: u16,
    /// Give up after this many consecutive failed attempts. `0` means never
    /// give up.
    #[serde(default)]
    pub reconnect_max_attempts: u32,
    /// Whether the guided tour has been finished or skipped. Drives the
    /// once-only auto-run on a fresh install.
    #[serde(default)]
    pub tour_completed: bool,
}

fn default_notifications_enabled() -> bool {
    true
}

fn default_auto_reconnect_enabled() -> bool {
    true
}

fn default_keepalive_interval_secs() -> u16 {
    15
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            autostart_enabled: false,
            port_range_min: 1080,
            port_range_max: 1179,
            notifications_enabled: true,
            auto_reconnect_enabled: true,
            keepalive_interval_secs: 15,
            reconnect_max_attempts: 0,
            tour_completed: false,
        }
    }
}

/// Router configuration. Kept in its own file rather than folded into
/// [`Settings`] so the settings panel writing back a whole `Settings` object
/// can't clobber router state edited from the other panel.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterConfig {
    pub enabled: bool,
    /// Local SOCKS5 port the router listens on. Always bound to 127.0.0.1.
    pub port: u16,
    /// Applied when no rule matches.
    pub default_action: RuleAction,
    pub default_tunnel_id: Option<Uuid>,
    /// Point the Windows system proxy at the router while it runs.
    pub set_system_proxy: bool,
    /// Windows `ProxyOverride` list used alongside the system proxy.
    pub bypass_list: String,
    /// Resolve hostnames locally so IP/CIDR rules can be tested against them.
    /// Off means CIDR rules only ever match literal-IP destinations.
    pub resolve_for_ip_rules: bool,
}

impl Default for RouterConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 1090,
            default_action: RuleAction::Direct,
            default_tunnel_id: None,
            set_system_proxy: true,
            bypass_list: "<local>".to_string(),
            resolve_for_ip_rules: true,
        }
    }
}

/// A single JSON document on disk, read once at startup and rewritten on every
/// update. Shared by settings and router config — both are small, low-churn, and
/// want the same "missing or corrupt file falls back to defaults" behavior.
pub struct JsonStore<T> {
    path: PathBuf,
    current: Mutex<T>,
}

impl<T: Clone + Serialize + DeserializeOwned + Default> JsonStore<T> {
    pub fn load(path: PathBuf) -> Self {
        let current = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            path,
            current: Mutex::new(current),
        }
    }

    pub fn get(&self) -> T {
        self.current.lock().unwrap().clone()
    }

    pub fn update(&self, value: T) {
        let mut current = self.current.lock().unwrap();
        *current = value;
        if let Ok(data) = serde_json::to_string_pretty(&*current) {
            let _ = std::fs::write(&self.path, data);
        }
    }
}

pub type SettingsStore = JsonStore<Settings>;
pub type RouterStore = JsonStore<RouterConfig>;
