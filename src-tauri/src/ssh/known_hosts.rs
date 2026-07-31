use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedKey {
    pub openssh_key: String,
    pub fingerprint: String,
    pub algorithm: String,
    pub trusted_at: u64,
}

/// Persisted trust store: `host:port` -> trusted public key + fingerprint.
/// Real TOFU (trust-on-first-use with explicit user confirmation), unlike the old
/// app's silent blind-trust-on-every-connect behavior.
pub struct KnownHosts {
    path: PathBuf,
    entries: Mutex<HashMap<String, TrustedKey>>,
}

impl KnownHosts {
    pub fn load(path: PathBuf) -> Self {
        let entries = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<HashMap<String, TrustedKey>>(&s).ok())
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
        entries.get(key_id).map(|known| known.openssh_key == openssh_key)
    }

    pub fn trust(&self, key_id: &str, openssh_key: &str, fingerprint: &str, algorithm: &str) {
        let mut entries = self.entries.lock().unwrap();
        entries.insert(
            key_id.to_string(),
            TrustedKey {
                openssh_key: openssh_key.to_string(),
                fingerprint: fingerprint.to_string(),
                algorithm: algorithm.to_string(),
                trusted_at: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            },
        );
        self.persist(&entries);
    }

    pub fn list(&self) -> Vec<(String, TrustedKey)> {
        let entries = self.entries.lock().unwrap();
        let mut list: Vec<_> = entries.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        list.sort_by(|a, b| a.0.cmp(&b.0));
        list
    }

    pub fn forget(&self, key_id: &str) {
        let mut entries = self.entries.lock().unwrap();
        entries.remove(key_id);
        self.persist(&entries);
    }

    fn persist(&self, entries: &HashMap<String, TrustedKey>) {
        if let Ok(data) = serde_json::to_string_pretty(entries) {
            let _ = std::fs::write(&self.path, data);
        }
    }
}
