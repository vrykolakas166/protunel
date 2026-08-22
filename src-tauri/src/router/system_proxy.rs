//! Points the Windows system proxy at the router while it runs, and puts the
//! machine back the way it was afterwards.
//!
//! The hard part is not setting the keys, it is *always* unsetting them. A
//! backup file on disk — written before the first mutation and deleted only
//! after a successful restore — is the recovery record: if the app is killed
//! mid-run, the next startup finds the backup and restores from it. That makes
//! [`disable`] safe to call unconditionally, including on a machine that was
//! never modified.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const BACKUP_FILE: &str = "system_proxy_backup.json";

/// Whether *this process* is the one that changed the system proxy.
///
/// A second launch exits immediately via the single-instance plugin, and its
/// `RunEvent::Exit` would otherwise restore the backup belonging to the instance
/// that is still running — silently stripping the live router's proxy settings.
/// Shutdown cleanup is gated on this; startup recovery is not, because that is
/// the crash-repair path and by then no instance owns the state.
static ENABLED_BY_THIS_PROCESS: AtomicBool = AtomicBool::new(false);

pub fn enabled_by_this_process() -> bool {
    ENABLED_BY_THIS_PROCESS.load(Ordering::SeqCst)
}

/// The WinINET values this touches, as they were before the router ran.
///
/// Only `auto_config_url` is actually written — see [`enable`] — but the fixed
/// proxy values are captured too so a restore can put back anything an older
/// build of this app had changed.
/// Every field is optional because *absent* and *present-but-empty/zero* are
/// different states in the registry, and a restore that cannot tell them apart
/// leaves a value behind that was never there. `None` means "there was no such
/// value; delete it again".
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ProxyBackup {
    #[serde(default)]
    proxy_enable: Option<u32>,
    #[serde(default)]
    proxy_server: Option<String>,
    #[serde(default)]
    proxy_override: Option<String>,
    #[serde(default)]
    auto_config_url: Option<String>,
}

fn backup_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(BACKUP_FILE))
        .map_err(|e| format!("no app data dir: {e}"))
}

fn read_backup(app: &AppHandle) -> Option<ProxyBackup> {
    let path = backup_path(app).ok()?;
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

#[cfg(windows)]
mod platform {
    use super::{backup_path, read_backup, ProxyBackup};
    use tauri::AppHandle;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    const INTERNET_SETTINGS: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

    fn open_settings() -> Result<RegKey, String> {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(INTERNET_SETTINGS, KEY_READ | KEY_WRITE)
            .map_err(|e| format!("cannot open Internet Settings registry key: {e}"))
    }

    fn snapshot(key: &RegKey) -> ProxyBackup {
        ProxyBackup {
            proxy_enable: key.get_value("ProxyEnable").ok(),
            proxy_server: key.get_value("ProxyServer").ok(),
            proxy_override: key.get_value("ProxyOverride").ok(),
            auto_config_url: key.get_value("AutoConfigURL").ok(),
        }
    }

    /// Restores one string value, deleting it when it was absent before. An
    /// empty string is treated as absent too, so backups written by an older
    /// build (which could not represent "absent") still restore cleanly.
    fn restore_string(key: &RegKey, name: &str, value: Option<&String>) -> Result<(), String> {
        match value.filter(|v| !v.is_empty()) {
            None => {
                let _ = key.delete_value(name);
                Ok(())
            }
            Some(value) => key
                .set_value(name, value)
                .map_err(|e| format!("cannot restore {name}: {e}")),
        }
    }

    fn restore_dword(key: &RegKey, name: &str, value: Option<u32>) -> Result<(), String> {
        match value {
            None => {
                let _ = key.delete_value(name);
                Ok(())
            }
            Some(value) => key
                .set_value(name, &value)
                .map_err(|e| format!("cannot restore {name}: {e}")),
        }
    }

    /// Tells running processes (browsers especially) to re-read the settings.
    /// Best-effort: a failure here only means apps pick the change up late.
    fn broadcast_change() {
        use windows_sys::Win32::Networking::WinInet::{
            InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
        };
        unsafe {
            InternetSetOptionW(
                std::ptr::null(),
                INTERNET_OPTION_SETTINGS_CHANGED,
                std::ptr::null(),
                0,
            );
            InternetSetOptionW(std::ptr::null(), INTERNET_OPTION_REFRESH, std::ptr::null(), 0);
        }
    }

    /// Points `AutoConfigURL` at the router's PAC script.
    ///
    /// Only that one value is written. The fixed-proxy keys are left alone: a
    /// PAC script takes precedence in WinINET anyway, and not touching them
    /// means a user's existing corporate proxy config survives untouched.
    pub fn enable(app: &AppHandle, pac_url: &str) -> Result<(), String> {
        let key = open_settings()?;

        // Only snapshot if there isn't one already. A second enable (port change,
        // restart) must not capture our own proxy settings as the "original".
        if read_backup(app).is_none() {
            let backup = snapshot(&key);
            let path = backup_path(app)?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let data = serde_json::to_string_pretty(&backup).map_err(|e| e.to_string())?;
            // Written before any mutation: if this fails we have not touched the
            // registry yet, and there is nothing to recover.
            std::fs::write(&path, data)
                .map_err(|e| format!("cannot write system proxy backup: {e}"))?;
        }

        key.set_value("AutoConfigURL", &pac_url.to_string())
            .map_err(|e| format!("cannot set AutoConfigURL: {e}"))?;
        super::ENABLED_BY_THIS_PROCESS.store(true, super::Ordering::SeqCst);

        broadcast_change();
        Ok(())
    }

    pub fn disable(app: &AppHandle) -> Result<(), String> {
        // No backup means the router never changed anything (or already put it
        // back). Nothing to do — this is the common path at startup.
        let Some(backup) = read_backup(app) else {
            return Ok(());
        };
        let key = open_settings()?;

        restore_string(&key, "AutoConfigURL", backup.auto_config_url.as_ref())?;
        // Older builds set the fixed-proxy keys instead; restoring them from the
        // backup is a no-op for backups this build wrote, and repairs machines
        // left dirty by one that did.
        restore_dword(&key, "ProxyEnable", backup.proxy_enable)?;
        restore_string(&key, "ProxyServer", backup.proxy_server.as_ref())?;
        restore_string(&key, "ProxyOverride", backup.proxy_override.as_ref())?;

        // Only now is the backup spent. If any restore above failed we kept it,
        // so the next startup tries again.
        if let Ok(path) = backup_path(app) {
            let _ = std::fs::remove_file(path);
        }
        super::ENABLED_BY_THIS_PROCESS.store(false, super::Ordering::SeqCst);
        broadcast_change();
        Ok(())
    }
}

#[cfg(not(windows))]
mod platform {
    use tauri::AppHandle;

    pub fn enable(_app: &AppHandle, _pac_url: &str) -> Result<(), String> {
        Err("system proxy configuration is only implemented on Windows".to_string())
    }

    pub fn disable(_app: &AppHandle) -> Result<(), String> {
        Ok(())
    }
}

pub use platform::{disable, enable};

/// Called once at startup, before the router starts. Restores the system proxy
/// if a previous run was killed without cleaning up.
pub fn recover(app: &AppHandle) {
    if read_backup(app).is_some() {
        if let Err(e) = disable(app) {
            eprintln!("[router] could not restore system proxy from backup: {e}");
        }
    }
}

/// Cleanup for `RunEvent::Exit`. Unlike [`recover`], this does nothing unless
/// this process is the one that set the proxy — a second launch bouncing off the
/// single-instance guard must not tear down the settings of the instance that is
/// still running.
pub fn cleanup_on_exit(app: &AppHandle) {
    if !enabled_by_this_process() {
        return;
    }
    if let Err(e) = disable(app) {
        eprintln!("[router] could not restore system proxy on exit: {e}");
    }
}
