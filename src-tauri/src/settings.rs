use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
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
    /// UI language: "en" or "vi".
    #[serde(default = "default_language")]
    pub language: String,
    /// Themes used while `theme` is "system": one for a light Windows, one
    /// for a dark one. `theme` itself is either "system" or a theme id.
    #[serde(default = "default_theme_light")]
    pub theme_light: String,
    #[serde(default = "default_theme_dark")]
    pub theme_dark: String,
    /// Whether programs on the server (tmux, vim, htop…) may take over the
    /// mouse in the terminal. Off: a plain drag always selects and copies.
    #[serde(default)]
    pub terminal_app_mouse: bool,
    /// When launched by the OS at sign-in, stay in the tray instead of
    /// opening the window. Launching by hand always shows it.
    #[serde(default)]
    pub start_minimized: bool,
    /// GPU (WebGL) rendering in the terminal. Off falls back to xterm's DOM
    /// renderer: native text rendering, sharper on standard-DPI screens.
    #[serde(default = "default_true")]
    pub terminal_webgl: bool,
    /// Download updates in the background as soon as they are found.
    #[serde(default = "default_true")]
    pub auto_update: bool,
    /// "simple" (one "internal network" switch, read-only tunnel list, for
    /// people who only browse through tunnels an administrator set up) or "full".
    /// `None` until the user picks: the first launch, including the first
    /// launch after updating from a version without modes, asks.
    #[serde(default)]
    pub ui_mode: Option<String>,
    /// Terminal suggestions: remember the commands typed per host (locally,
    /// never exported) to offer the usual opening sequence and fixes after
    /// common errors. Off also stops recording.
    #[serde(default = "default_true")]
    pub terminal_suggestions: bool,
    /// A command that ran at least this long, finishing while its pane is out
    /// of sight, raises a desktop notification. 0 turns it off.
    #[serde(default = "default_long_command_secs")]
    pub terminal_long_command_secs: u32,
    /// The folder last picked by the file panel's "Download to folder…".
    #[serde(default)]
    pub files_download_dir: Option<String>,
    /// In a tab with several panes, the ones without focus are dimmed a
    /// little. Off by default: it makes watched panes harder to read.
    #[serde(default)]
    pub terminal_dim_inactive: bool,
}

fn default_long_command_secs() -> u32 {
    15
}

fn default_true() -> bool {
    true
}

fn default_theme_light() -> String {
    "protunel_light".to_string()
}

fn default_theme_dark() -> String {
    "protunel_dark".to_string()
}

fn default_language() -> String {
    "en".to_string()
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
            language: default_language(),
            theme_light: default_theme_light(),
            theme_dark: default_theme_dark(),
            terminal_app_mouse: false,
            start_minimized: false,
            terminal_webgl: true,
            auto_update: true,
            ui_mode: None,
            terminal_suggestions: true,
            terminal_long_command_secs: default_long_command_secs(),
            files_download_dir: None,
            terminal_dim_inactive: false,
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
        let current = load_json(&path).unwrap_or_default();
        Self {
            path,
            current: Mutex::new(current),
        }
    }

    pub fn get(&self) -> T {
        self.current.lock().unwrap().clone()
    }

    /// Replaces the value and writes it out. The in-memory value changes even
    /// when the write fails, so the app keeps working; the error says it
    /// won't survive a restart.
    pub fn update(&self, value: T) -> Result<(), String> {
        let mut current = self.current.lock().unwrap();
        *current = value;
        let data = serde_json::to_string_pretty(&*current).map_err(|e| e.to_string())?;
        write_atomic(&self.path, data.as_bytes())
            .map_err(|e| format!("cannot save {}: {e}", self.path.display()))
    }

    /// `update` for background bookkeeping nobody waits on: a failed write
    /// is logged, not returned.
    pub fn update_or_log(&self, value: T) {
        if let Err(e) = self.update(value) {
            eprintln!("protunel: {e}");
        }
    }
}

/// Reads a JSON file. Missing is `None` (first run). Present but unreadable
/// is also `None`, after moving the file aside to `<name>.corrupt`: falling
/// back to defaults is better than refusing to start, but the next write must
/// not destroy what might still be recovered by hand.
pub fn load_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            eprintln!("protunel: cannot read {}: {e}", path.display());
            return None;
        }
    };
    match serde_json::from_str(&text) {
        Ok(value) => Some(value),
        Err(e) => {
            let aside = path.with_extension("json.corrupt");
            eprintln!(
                "protunel: {} is unreadable ({e}); moved to {} and starting from defaults",
                path.display(),
                aside.display()
            );
            let _ = std::fs::rename(path, &aside);
            None
        }
    }
}

/// Writes through a temporary file renamed over the target, so a crash or
/// power cut mid-write leaves the old file intact instead of a truncated one
/// (which the next start would read as corrupt). The data is flushed to disk
/// before the rename.
pub fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("json.tmp");
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(data)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

pub type SettingsStore = JsonStore<Settings>;
pub type RouterStore = JsonStore<RouterConfig>;

/// One entry in the recent-captures MRU list — enough to relaunch the same
/// target without re-browsing for it.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentCapture {
    pub exe_path: String,
    pub args: Vec<String>,
    pub label: Option<String>,
    pub last_launched_at: u64,
}

/// Automatic MRU list of launched capture targets, capped at
/// [`crate::capture::MAX_RECENT_CAPTURES`]. Separate file from
/// [`RouterConfig`]/[`Settings`] for the same reason those are split — an
/// independent writer shouldn't be able to clobber another panel's state.
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CaptureConfig {
    #[serde(default)]
    pub recent: Vec<RecentCapture>,
}

pub type CaptureStore = JsonStore<CaptureConfig>;

/// What the terminal window learns from use, in `terminal_memory.json`: the
/// commands typed per host and the saved workspaces. Local only — commands can
/// hold secrets, so this file is never part of a config export. The terminal
/// window owns the logic; Rust only persists the document.
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMemory {
    /// Keyed by tunnel id.
    #[serde(default)]
    pub hosts: std::collections::HashMap<String, HostMemory>,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostMemory {
    /// The opening commands of recent shells, oldest first.
    #[serde(default)]
    pub sessions: Vec<Vec<String>>,
    /// Command → times run, for "did you mean" after `command not found`.
    #[serde(default)]
    pub commands: std::collections::HashMap<String, u32>,
    /// Suggested sequences the user dismissed (key → times in a row).
    #[serde(default)]
    pub dismissed: std::collections::HashMap<String, u32>,
}

/// A named set of terminal tabs; `tabs` holds the window's layout trees as-is.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub tabs: Vec<serde_json::Value>,
}

pub type TerminalMemoryStore = JsonStore<TerminalMemory>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("protunel-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn update_writes_and_leaves_no_temp_file() {
        let dir = scratch("write");
        let path = dir.join("settings.json");
        let store = JsonStore::<RouterConfig>::load(path.clone());
        let config = RouterConfig { port: 4321, ..RouterConfig::default() };
        store.update(config).unwrap();
        assert_eq!(JsonStore::<RouterConfig>::load(path.clone()).get().port, 4321);
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn corrupt_file_is_set_aside_not_overwritten() {
        let dir = scratch("corrupt");
        let path = dir.join("known_hosts.json");
        std::fs::write(&path, "{ truncated").unwrap();
        let loaded: Option<HashMap<String, String>> = load_json(&path);
        assert!(loaded.is_none());
        assert!(!path.exists());
        assert_eq!(std::fs::read_to_string(path.with_extension("json.corrupt")).unwrap(), "{ truncated");
    }

    #[test]
    fn missing_file_is_a_first_run() {
        let dir = scratch("missing");
        let loaded: Option<RouterConfig> = load_json(&dir.join("router.json"));
        assert!(loaded.is_none());
        assert!(!dir.join("router.json.corrupt").exists());
    }
}
