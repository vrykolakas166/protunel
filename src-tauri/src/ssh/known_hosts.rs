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

/// A server that offered a different key than the trusted one. In memory
/// only: it describes a refused connection, not something to persist.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyMismatch {
    pub key_id: String,
    pub known_fingerprint: String,
    pub known_algorithm: String,
    pub trusted_at: u64,
    pub offered_fingerprint: String,
    pub offered_algorithm: String,
}

/// Persisted trust store: `host:port` -> trusted public key + fingerprint.
/// Real TOFU (trust-on-first-use with explicit user confirmation), unlike the old
/// app's silent blind-trust-on-every-connect behavior.
pub struct KnownHosts {
    path: PathBuf,
    entries: Mutex<HashMap<String, TrustedKey>>,
    mismatches: Mutex<HashMap<String, HostKeyMismatch>>,
}

impl KnownHosts {
    pub fn load(path: PathBuf) -> Self {
        // An unreadable file is set aside, not overwritten: losing trusted
        // keys silently would turn every host back into a first connection.
        let entries = crate::settings::load_json::<HashMap<String, TrustedKey>>(&path).unwrap_or_default();
        Self {
            path,
            entries: Mutex::new(entries),
            mismatches: Mutex::new(HashMap::new()),
        }
    }

    /// Returns `Some(true)` if the key matches the stored one, `Some(false)` if it
    /// mismatches (possible MITM), or `None` if the host has never been seen before.
    pub fn check(&self, key_id: &str, openssh_key: &str) -> Option<bool> {
        let entries = self.entries.lock().unwrap();
        entries.get(key_id).map(|known| known.openssh_key == openssh_key)
    }

    pub fn openssh_key(&self, key_id: &str) -> Option<String> {
        let entries = self.entries.lock().unwrap();
        entries.get(key_id).map(|known| known.openssh_key.clone())
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

    /// Adds imported entries, keeping the existing key on conflict. Silently
    /// replacing a trusted key from a config file would defeat the point of
    /// TOFU — a mismatch has to stay a mismatch until the user forgets the old
    /// one deliberately. Returns how many were actually added.
    pub fn merge(&self, entries: Vec<(String, TrustedKey)>) -> usize {
        let mut current = self.entries.lock().unwrap();
        let mut added = 0;
        for (key_id, key) in entries {
            if !current.contains_key(&key_id) {
                current.insert(key_id, key);
                added += 1;
            }
        }
        if added > 0 {
            self.persist(&current);
        }
        added
    }

    pub fn forget(&self, key_id: &str) {
        let mut entries = self.entries.lock().unwrap();
        entries.remove(key_id);
        self.persist(&entries);
        self.mismatches.lock().unwrap().remove(key_id);
    }

    /// Notes a refused key so the UI can show both fingerprints. Returns the
    /// record, or `None` when the host is not (or no longer) trusted.
    pub fn record_mismatch(&self, key_id: &str, offered_fingerprint: &str, offered_algorithm: &str) -> Option<HostKeyMismatch> {
        let entries = self.entries.lock().unwrap();
        let known = entries.get(key_id)?;
        let mismatch = HostKeyMismatch {
            key_id: key_id.to_string(),
            known_fingerprint: known.fingerprint.clone(),
            known_algorithm: known.algorithm.clone(),
            trusted_at: known.trusted_at,
            offered_fingerprint: offered_fingerprint.to_string(),
            offered_algorithm: offered_algorithm.to_string(),
        };
        self.mismatches.lock().unwrap().insert(key_id.to_string(), mismatch.clone());
        Some(mismatch)
    }

    /// Developer tools: records a mismatch whether or not the host is trusted.
    pub fn record_fake_mismatch(&self, key_id: &str) -> HostKeyMismatch {
        let mismatch = HostKeyMismatch {
            key_id: key_id.to_string(),
            known_fingerprint: "SHA256:SIMULATEDknownKEYxxxxxxxxxxxxxxxxxxxxxxxxxx".into(),
            known_algorithm: "ssh-ed25519".into(),
            trusted_at: 0,
            offered_fingerprint: "SHA256:SIMULATEDofferedKEYyyyyyyyyyyyyyyyyyyyyyyyy".into(),
            offered_algorithm: "ssh-ed25519".into(),
        };
        self.mismatches.lock().unwrap().insert(key_id.to_string(), mismatch.clone());
        mismatch
    }

    /// The trusted key matched again (e.g. a DNS blip pointed elsewhere).
    pub fn clear_mismatch(&self, key_id: &str) {
        self.mismatches.lock().unwrap().remove(key_id);
    }

    pub fn mismatches(&self) -> Vec<HostKeyMismatch> {
        self.mismatches.lock().unwrap().values().cloned().collect()
    }

    fn persist(&self, entries: &HashMap<String, TrustedKey>) {
        if let Ok(data) = serde_json::to_string_pretty(entries) {
            if let Err(e) = crate::settings::write_atomic(&self.path, data.as_bytes()) {
                eprintln!("protunel: cannot save {}: {e}", self.path.display());
            }
        }
    }
}
