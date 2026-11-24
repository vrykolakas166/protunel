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

fn read_backup(path: Result<PathBuf, String>) -> Option<ProxyBackup> {
    let data = std::fs::read_to_string(path.ok()?).ok()?;
    serde_json::from_str(&data).ok()
}

#[cfg(windows)]
mod platform {
    use super::{backup_path, read_backup, PathBuf, ProxyBackup};
    use tauri::AppHandle;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    const INTERNET_SETTINGS: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

    struct ProxySettings<'a> {
        registry_path: &'a str,
        backup_path: &'a dyn Fn() -> Result<PathBuf, String>,
        on_change: fn(bool),
    }

    fn system_settings(backup_path: &dyn Fn() -> Result<PathBuf, String>) -> ProxySettings<'_> {
        ProxySettings {
            registry_path: INTERNET_SETTINGS,
            backup_path,
            on_change: |enabled| {
                super::ENABLED_BY_THIS_PROCESS.store(enabled, super::Ordering::SeqCst);
                broadcast_change();
            },
        }
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
        system_settings(&|| backup_path(app)).enable(pac_url)
    }

    pub fn disable(app: &AppHandle) -> Result<(), String> {
        system_settings(&|| backup_path(app)).disable()
    }

    pub fn recover(app: &AppHandle) {
        system_settings(&|| backup_path(app)).recover();
    }

    impl ProxySettings<'_> {
        fn open_settings(&self) -> Result<RegKey, String> {
            RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey_with_flags(self.registry_path, KEY_READ | KEY_WRITE)
                .map_err(|e| format!("cannot open Internet Settings registry key: {e}"))
        }

        fn read_backup(&self) -> Option<ProxyBackup> {
            read_backup((self.backup_path)())
        }

        fn enable(&self, pac_url: &str) -> Result<(), String> {
            let key = self.open_settings()?;

            // Only snapshot if there isn't one already. A second enable (port change,
            // restart) must not capture our own proxy settings as the "original".
            if self.read_backup().is_none() {
                let backup = snapshot(&key);
                let path = (self.backup_path)()?;
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let data = serde_json::to_string_pretty(&backup).map_err(|e| e.to_string())?;
                // Written before any mutation: if this fails we have not touched the
                // registry yet, and there is nothing to recover.
                crate::settings::write_atomic(&path, data.as_bytes())
                    .map_err(|e| format!("cannot write system proxy backup: {e}"))?;
            }

            key.set_value("AutoConfigURL", &pac_url.to_string())
                .map_err(|e| format!("cannot set AutoConfigURL: {e}"))?;
            (self.on_change)(true);
            Ok(())
        }

        fn disable(&self) -> Result<(), String> {
            // No backup means the router never changed anything (or already put it
            // back). Nothing to do — this is the common path at startup.
            let Some(backup) = self.read_backup() else {
                return Ok(());
            };
            let key = self.open_settings()?;

            restore_string(&key, "AutoConfigURL", backup.auto_config_url.as_ref())?;
            // Older builds set the fixed-proxy keys instead; restoring them from the
            // backup is a no-op for backups this build wrote, and repairs machines
            // left dirty by one that did.
            restore_dword(&key, "ProxyEnable", backup.proxy_enable)?;
            restore_string(&key, "ProxyServer", backup.proxy_server.as_ref())?;
            restore_string(&key, "ProxyOverride", backup.proxy_override.as_ref())?;

            // Only now is the backup spent. If any restore above failed we kept it,
            // so the next startup tries again.
            if let Ok(path) = (self.backup_path)() {
                let _ = std::fs::remove_file(path);
            }
            (self.on_change)(false);
            Ok(())
        }

        fn recover(&self) {
            if self.read_backup().is_some() {
                if let Err(e) = self.disable() {
                    eprintln!("[router] could not restore system proxy from backup: {e}");
                }
            }
        }
    }

    #[cfg(all(test, windows))]
    mod tests {
        use super::*;
        use std::collections::BTreeMap;
        use std::fs;
        use uuid::Uuid;
        use winreg::RegValue;

        const PAC_URL: &str = "http://127.0.0.1:1080/protunel.pac";
        const USER_PAC: &str = "http://proxy.example.test/user.pac";

        struct Scratch {
            root: String,
            registry_path: String,
            dir: PathBuf,
        }

        impl Scratch {
            fn new() -> Self {
                let name = format!("protunel-test-{}", Uuid::new_v4());
                let root = format!(r"Software\{name}");
                let scratch = Self {
                    registry_path: format!(r"{root}\Internet Settings"),
                    root,
                    dir: std::env::temp_dir().join(name),
                };
                RegKey::predef(HKEY_CURRENT_USER)
                    .create_subkey_with_flags(&scratch.registry_path, KEY_READ | KEY_WRITE)
                    .expect("create scratch HKCU Internet Settings key");
                fs::create_dir(&scratch.dir).unwrap();
                scratch
            }

            fn settings<'a>(
                &'a self,
                backup_path: &'a dyn Fn() -> Result<PathBuf, String>,
            ) -> ProxySettings<'a> {
                ProxySettings {
                    registry_path: &self.registry_path,
                    backup_path,
                    on_change: |_| {},
                }
            }

            fn backup(&self) -> PathBuf {
                self.dir.join(super::super::BACKUP_FILE)
            }
        }

        impl Drop for Scratch {
            fn drop(&mut self) {
                let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&self.root);
                let _ = fs::remove_dir_all(&self.dir);
            }
        }

        fn values(key: &RegKey) -> BTreeMap<String, RegValue> {
            key.enum_values().collect::<Result<_, _>>().unwrap()
        }

        #[test]
        fn win_proxy_enable_captures_fixed_settings_and_preserves_user_proxy() {
            let scratch = Scratch::new();
            let backup_path = || Ok(scratch.backup());
            let settings = scratch.settings(&backup_path);
            let key = settings.open_settings().unwrap();
            key.set_value("AutoConfigURL", &USER_PAC).unwrap();
            key.set_value("ProxyEnable", &1u32).unwrap();
            key.set_value("ProxyServer", &"proxy.example.test:8080")
                .unwrap();
            key.set_value("ProxyOverride", &"<local>;*.example.test")
                .unwrap();
            key.set_value("Unrelated", &42u32).unwrap();
            let original = values(&key);

            settings.enable(PAC_URL).unwrap();
            assert_eq!(
                key.get_value::<String, _>("AutoConfigURL").unwrap(),
                PAC_URL
            );
            let mut enabled = values(&key);
            enabled.remove("AutoConfigURL").unwrap();
            assert!(enabled
                .iter()
                .eq(original.iter().filter(|(name, _)| *name != "AutoConfigURL")));
            let backup = settings.read_backup().unwrap();
            assert_eq!(backup.auto_config_url.as_deref(), Some(USER_PAC));
            assert_eq!(backup.proxy_enable, Some(1));
            assert_eq!(
                backup.proxy_server.as_deref(),
                Some("proxy.example.test:8080")
            );
            assert_eq!(
                backup.proxy_override.as_deref(),
                Some("<local>;*.example.test")
            );

            let saved = fs::read(scratch.backup()).unwrap();
            settings
                .enable("http://127.0.0.1:1081/protunel.pac")
                .unwrap();
            assert_eq!(fs::read(scratch.backup()).unwrap(), saved);
            settings.disable().unwrap();
            assert_eq!(values(&key), original);
            assert!(!scratch.backup().exists());
        }

        #[test]
        fn win_proxy_backup_failure_prevents_registry_mutation() {
            let scratch = Scratch::new();
            fs::create_dir(scratch.backup()).unwrap();
            let backup_path = || Ok(scratch.backup());
            let settings = scratch.settings(&backup_path);
            let key = settings.open_settings().unwrap();
            key.set_value("AutoConfigURL", &USER_PAC).unwrap();
            let original = values(&key);
            let error = settings.enable(PAC_URL).unwrap_err();
            assert!(
                error.starts_with("cannot write system proxy backup:"),
                "{error}"
            );
            assert_eq!(values(&key), original);
        }

        #[test]
        fn win_proxy_disable_deletes_values_that_were_absent() {
            let scratch = Scratch::new();
            let backup_path = || Ok(scratch.backup());
            let settings = scratch.settings(&backup_path);
            let key = settings.open_settings().unwrap();
            settings.enable(PAC_URL).unwrap();
            assert_eq!(values(&key).keys().collect::<Vec<_>>(), ["AutoConfigURL"]);
            // Simulate fixed-proxy values left behind by an older build.
            key.set_value("ProxyEnable", &1u32).unwrap();
            key.set_value("ProxyServer", &"stale proxy").unwrap();
            key.set_value("ProxyOverride", &"stale bypass").unwrap();
            settings.disable().unwrap();
            assert!(values(&key).is_empty());
            assert!(!scratch.backup().exists());
        }

        #[test]
        fn win_proxy_disable_without_backup_is_a_noop() {
            let scratch = Scratch::new();
            let backup_path = || Ok(scratch.backup());
            let settings = scratch.settings(&backup_path);
            let key = settings.open_settings().unwrap();
            key.set_value("AutoConfigURL", &USER_PAC).unwrap();
            key.set_value("ProxyEnable", &0u32).unwrap();
            let original = values(&key);
            settings.disable().unwrap();
            assert_eq!(values(&key), original);
            assert!(!scratch.backup().exists());
        }

        #[test]
        fn win_proxy_recovers_persisted_backup_after_crash() {
            let scratch = Scratch::new();
            let backup_path = || Ok(scratch.backup());
            let settings = scratch.settings(&backup_path);
            let key = settings.open_settings().unwrap();
            let user_proxy = "proxy.example.test:8080";
            key.set_value("AutoConfigURL", &PAC_URL).unwrap();
            key.set_value("ProxyEnable", &1u32).unwrap();
            key.set_value("ProxyServer", &"stale proxy").unwrap();
            key.set_value("ProxyOverride", &"stale bypass").unwrap();
            fs::write(
                scratch.backup(),
                format!(
                    r#"{{"autoConfigUrl":"{USER_PAC}","proxyEnable":0,"proxyServer":"{user_proxy}"}}"#
                ),
            )
            .unwrap();

            settings.recover();
            assert_eq!(
                key.get_value::<String, _>("AutoConfigURL").unwrap(),
                USER_PAC
            );
            assert_eq!(key.get_value::<u32, _>("ProxyEnable").unwrap(), 0);
            assert_eq!(key.get_value::<String, _>("ProxyServer").unwrap(), user_proxy);
            assert_eq!(values(&key).len(), 3);
            assert!(!scratch.backup().exists());
        }
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
#[cfg(windows)]
pub use platform::recover;

#[cfg(not(windows))]
pub fn recover(app: &AppHandle) {
    if read_backup(backup_path(app)).is_some() {
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
