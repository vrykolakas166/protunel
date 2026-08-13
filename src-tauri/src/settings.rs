use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

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
        }
    }
}

pub struct SettingsStore {
    path: PathBuf,
    current: Mutex<Settings>,
}

impl SettingsStore {
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

    pub fn get(&self) -> Settings {
        self.current.lock().unwrap().clone()
    }

    pub fn update(&self, settings: Settings) {
        let mut current = self.current.lock().unwrap();
        *current = settings;
        if let Ok(data) = serde_json::to_string_pretty(&*current) {
            let _ = std::fs::write(&self.path, data);
        }
    }
}
