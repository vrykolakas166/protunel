use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// Persisted trust store: `host:port` -> OpenSSH-formatted public key.
/// Real TOFU (trust-on-first-use with explicit user confirmation), unlike the old
/// app's silent blind-trust-on-every-connect behavior.
pub struct KnownHosts {
    path: PathBuf,
    entries: Mutex<HashMap<String, String>>,
}

impl KnownHosts {
    pub fn load(path: PathBuf) -> Self {
        let entries = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<HashMap<String, String>>(&s).ok())
            .unwrap_or_default();
        Self {
            path,
            entries: Mutex::new(entries),
        }
    }

    /// Returns `Some(true)` if the key matches the stored one, `Some(false)` if it
    /// mismatches (possible MITM), or `None` if the host has never been seen before.
    pub fn check(&self, key_id: &str, openssh_key: &str) -> Option<bool> {
        let entries = self.entries.lock().unwrap();
        entries.get(key_id).map(|known| known == openssh_key)
    }

    pub fn trust(&self, key_id: &str, openssh_key: &str) {
        let mut entries = self.entries.lock().unwrap();
        entries.insert(key_id.to_string(), openssh_key.to_string());
        if let Ok(data) = serde_json::to_string_pretty(&*entries) {
            let _ = std::fs::write(&self.path, data);
        }
    }
}
