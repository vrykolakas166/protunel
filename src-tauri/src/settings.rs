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
}

fn default_notifications_enabled() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            autostart_enabled: false,
            port_range_min: 1080,
            port_range_max: 1179,
            notifications_enabled: true,
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
