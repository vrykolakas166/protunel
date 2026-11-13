//! Reports which OS services the app depends on are actually reachable, so the
//! UI can say "install X" up front instead of failing later with an opaque
//! keyring or agent error mid-connect. Matters on Linux, where a minimal
//! compositor setup (Hyprland, sway, i3) often has no Secret Service and no
//! agent socket exported; on Windows both always exist.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformStatus {
    /// `XDG_CURRENT_DESKTOP`, lower-cased, e.g. `"hyprland"`, `"kde"`,
    /// `"gnome"`. Empty on Windows or when unset.
    pub desktop: String,
    /// The credential vault answered. False means saving a password fails.
    pub vault_available: bool,
    /// `SSH_AUTH_SOCK` points at an existing socket. Always true on Windows,
    /// where the agent is Pageant and needs no environment.
    pub ssh_agent_available: bool,
    /// Install command prefix for this distro (`"sudo pacman -S --needed"`,
    /// `"sudo apt install"`, `"sudo dnf install"`), so fix hints can be pasted
    /// as-is. Empty when unknown or on Windows.
    pub install_command: String,
    /// How to start this app from a shell: the AppImage itself when running
    /// from one (the exe path then points into a temporary mount), else the
    /// executable. Hyprland ignores XDG autostart entries, so the UI turns
    /// this into an `exec-once` line.
    pub launch_command: String,
    /// Whether the in-app updater can replace this install. On Linux it only
    /// handles AppImages; a pacman/apt-installed copy must be updated by the
    /// package manager, or the updater offers an update it then fails to apply.
    pub self_update: bool,
}

#[tauri::command]
pub async fn platform_status() -> PlatformStatus {
    // The keyring backend on Linux talks D-Bus synchronously and can stall for
    // the D-Bus timeout when no Secret Service is registered.
    let vault_available = tauri::async_runtime::spawn_blocking(probe_vault)
        .await
        .unwrap_or(false);
    PlatformStatus {
        desktop: desktop(),
        vault_available,
        ssh_agent_available: ssh_agent_available(),
        install_command: install_command(),
        launch_command: launch_command(),
        self_update: cfg!(windows) || std::env::var_os("APPIMAGE").is_some(),
    }
}

/// A lookup of an id that never exists: "no entry" proves the vault answered,
/// any other error means it is unreachable or locked away from us.
fn probe_vault() -> bool {
    crate::secrets::get_secret(uuid::Uuid::nil()).is_ok()
}

fn desktop() -> String {
    if cfg!(windows) {
        return String::new();
    }
    std::env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .to_lowercase()
}

fn ssh_agent_available() -> bool {
    if cfg!(windows) {
        return true;
    }
    std::env::var_os("SSH_AUTH_SOCK")
        .map(|path| std::path::Path::new(&path).exists())
        .unwrap_or(false)
}

/// Reads `ID` and `ID_LIKE` from os-release, so derivatives (EndeavourOS,
/// Manjaro, Mint, Pop!_OS…) map to their base distro's package manager.
fn install_command() -> String {
    let Ok(text) = std::fs::read_to_string("/etc/os-release") else {
        return String::new();
    };
    let ids: Vec<String> = text
        .lines()
        .filter_map(|line| {
            line.strip_prefix("ID=")
                .or_else(|| line.strip_prefix("ID_LIKE="))
        })
        .flat_map(|value| {
            value
                .trim_matches('"')
                .split_whitespace()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .collect();
    let has = |id: &str| ids.iter().any(|i| i == id);
    if has("arch") {
        "sudo pacman -S --needed".into()
    } else if has("debian") || has("ubuntu") {
        "sudo apt install".into()
    } else if has("fedora") || has("rhel") {
        "sudo dnf install".into()
    } else {
        String::new()
    }
}

fn launch_command() -> String {
    std::env::var("APPIMAGE")
        .ok()
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        })
        .unwrap_or_default()
}
