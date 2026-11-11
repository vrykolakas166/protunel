//! Export and import of the whole app configuration as one JSON file.
//!
//! Everything except the secrets travels in the clear — hosts, ports,
//! usernames, forwards, router rules, settings. SSH passwords and key
//! passphrases live in the Windows Credential Manager and are only included
//! when the user supplies a passphrase, sealed in their own block so the rest of
//! the file stays readable and diffable.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use rand::TryRngCore;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;
use zeroize::Zeroize;

use crate::db::{PortForward, Tunnel};
use crate::router::rules::RouterRule;
use crate::secrets;
use crate::settings::{RouterConfig, Settings};
use crate::ssh::known_hosts::TrustedKey;
use crate::AppState;

const FORMAT: &str = "protunel-config";
const VERSION: u32 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;

/// The secrets map, sealed. Salt and nonce are freshly generated on every
/// export, so the same passphrase never produces the same key twice and nonce
/// reuse is not reachable.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SealedSecrets {
    pub kdf: String,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigBundle {
    pub format: String,
    pub version: u32,
    pub exported_at: u64,
    pub app_version: String,
    pub tunnels: Vec<Tunnel>,
    pub router_config: RouterConfig,
    pub router_rules: Vec<RouterRule>,
    pub settings: Settings,
    pub known_hosts: Vec<(String, TrustedKey)>,
    /// Absent entirely when the export was made without a passphrase.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secrets: Option<SealedSecrets>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn random_bytes(len: usize) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; len];
    rand::rngs::OsRng
        .try_fill_bytes(&mut buf)
        .map_err(|e| format!("failed to gather randomness: {e}"))?;
    Ok(buf)
}

/// Argon2id, default parameters, into a 32-byte AES key. The derived key is
/// zeroized by the caller once the cipher has been built.
fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    argon2::Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| format!("key derivation failed: {e}"))?;
    Ok(key)
}

pub fn seal(plaintext: &[u8], passphrase: &str) -> Result<SealedSecrets, String> {
    let salt = random_bytes(SALT_LEN)?;
    let nonce_bytes = random_bytes(NONCE_LEN)?;

    let mut key_bytes = derive_key(passphrase, &salt)?;
    let key = Key::<Aes256Gcm>::try_from(&key_bytes[..])
        .map_err(|_| "derived key has the wrong length".to_string())?;
    let cipher = Aes256Gcm::new(&key);
    key_bytes.zeroize();

    let nonce = Nonce::try_from(&nonce_bytes[..])
        .map_err(|_| "nonce has the wrong length".to_string())?;
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|_| "failed to encrypt secrets".to_string())?;

    Ok(SealedSecrets {
        kdf: "argon2id".to_string(),
        salt: BASE64.encode(&salt),
        nonce: BASE64.encode(&nonce_bytes),
        ciphertext: BASE64.encode(&ciphertext),
    })
}

pub fn open(sealed: &SealedSecrets, passphrase: &str) -> Result<Vec<u8>, String> {
    if sealed.kdf != "argon2id" {
        return Err(format!("unsupported key derivation: {}", sealed.kdf));
    }
    let salt = BASE64
        .decode(&sealed.salt)
        .map_err(|_| "corrupt salt in export file".to_string())?;
    let nonce_bytes = BASE64
        .decode(&sealed.nonce)
        .map_err(|_| "corrupt nonce in export file".to_string())?;
    let ciphertext = BASE64
        .decode(&sealed.ciphertext)
        .map_err(|_| "corrupt ciphertext in export file".to_string())?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err("corrupt nonce in export file".to_string());
    }

    let mut key_bytes = derive_key(passphrase, &salt)?;
    let key = Key::<Aes256Gcm>::try_from(&key_bytes[..])
        .map_err(|_| "derived key has the wrong length".to_string())?;
    let cipher = Aes256Gcm::new(&key);
    key_bytes.zeroize();

    let nonce = Nonce::try_from(&nonce_bytes[..])
        .map_err(|_| "corrupt nonce in export file".to_string())?;
    // A failed authentication tag is overwhelmingly a wrong passphrase, and
    // saying "decryption failed" sends people hunting for a corrupt file.
    cipher
        .decrypt(&nonce, ciphertext.as_ref())
        .map_err(|_| "wrong passphrase (or the file has been modified)".to_string())
}

/// Which parts of the config to write. Mirrors `ImportSections` so the export
/// and import screens offer the same granularity.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSections {
    pub tunnels: bool,
    /// Ids to include when `tunnels` is true. Empty means none, not "all" —
    /// the frontend always sends the checked set explicitly.
    pub tunnel_ids: Vec<Uuid>,
    pub router: bool,
    pub settings: bool,
    pub known_hosts: bool,
}

fn build_bundle(
    app: &AppHandle,
    state: &AppState,
    passphrase: Option<&str>,
    sections: &ExportSections,
) -> Result<ConfigBundle, String> {
    let tunnels: Vec<Tunnel> = if sections.tunnels {
        let ids: std::collections::HashSet<Uuid> = sections.tunnel_ids.iter().copied().collect();
        state
            .db
            .list()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|t| ids.contains(&t.id))
            .collect()
    } else {
        Vec::new()
    };

    // Scoped to the tunnels actually being exported, so narrowing the tunnel
    // selection also narrows which secrets leave the machine.
    let secrets = match passphrase {
        None => None,
        Some(passphrase) => {
            let mut map: HashMap<String, String> = HashMap::new();
            for tunnel in &tunnels {
                if let Ok(Some(secret)) = secrets::get_secret(tunnel.id) {
                    map.insert(tunnel.id.to_string(), secret);
                }
            }
            let mut json = serde_json::to_vec(&map).map_err(|e| e.to_string())?;
            let sealed = seal(&json, passphrase)?;
            json.zeroize();
            Some(sealed)
        }
    };

    Ok(ConfigBundle {
        format: FORMAT.to_string(),
        version: VERSION,
        exported_at: now_secs(),
        app_version: app.package_info().version.to_string(),
        tunnels,
        router_config: if sections.router {
            state.router.config()
        } else {
            RouterConfig::default()
        },
        router_rules: if sections.router {
            state.db.list_router_rules().map_err(|e| e.to_string())?
        } else {
            Vec::new()
        },
        settings: if sections.settings {
            state.settings.get()
        } else {
            Settings::default()
        },
        known_hosts: if sections.known_hosts {
            state.known_hosts.list()
        } else {
            Vec::new()
        },
        secrets,
    })
}

fn read_bundle(path: &str) -> Result<ConfigBundle, String> {
    let data = std::fs::read_to_string(path).map_err(|e| format!("cannot read file: {e}"))?;
    let bundle: ConfigBundle =
        serde_json::from_str(&data).map_err(|e| format!("not a valid config file: {e}"))?;
    if bundle.format != FORMAT {
        return Err("this is not a ProdTunnel config file".to_string());
    }
    if bundle.version > VERSION {
        return Err(format!(
            "file was written by a newer version (format v{}, this build understands v{VERSION})",
            bundle.version
        ));
    }
    Ok(bundle)
}

/// Writes the config to a user-chosen file. `passphrase` of `None` omits the
/// secrets block entirely rather than writing it unprotected.
#[tauri::command]
pub async fn export_config(
    app: AppHandle,
    state: State<'_, AppState>,
    passphrase: Option<String>,
    sections: ExportSections,
) -> Result<Option<String>, String> {
    let passphrase = passphrase.filter(|p| !p.is_empty());
    let bundle = build_bundle(&app, &state, passphrase.as_deref(), &sections)?;
    let json = serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("ProdTunnel config", &["json"])
        .set_file_name("protunel-config.json")
        .save_file(move |path| {
            let _ = tx.send(path);
        });

    let Some(path) = rx.await.map_err(|_| "file dialog closed".to_string())? else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|e| format!("unusable path: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("cannot write file: {e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn pick_import_file(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("ProdTunnel config", &["json"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });

    let Some(path) = rx.await.map_err(|_| "file dialog closed".to_string())? else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|e| format!("unusable path: {e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// What importing `id` would do to the current config.
#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TunnelDisposition {
    New,
    /// Same id as an existing tunnel — the same tunnel, updated in place.
    Overwrite,
    /// Different id but the same name, so the user has to say which they meant.
    NameConflict,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelPreview {
    pub id: Uuid,
    pub name: String,
    pub host: String,
    pub disposition: TunnelDisposition,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub app_version: String,
    pub exported_at: u64,
    pub tunnels: Vec<TunnelPreview>,
    pub router_rule_count: usize,
    pub current_router_rule_count: usize,
    pub known_host_count: usize,
    pub has_secrets: bool,
    /// True once a passphrase has actually decrypted the block.
    pub secrets_unlocked: bool,
    pub secret_count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSections {
    pub tunnels: bool,
    pub router: bool,
    pub settings: bool,
    pub known_hosts: bool,
    pub secrets: bool,
    /// On a same-name/different-id collision: replace the existing tunnel, or
    /// bring the imported one in alongside it under a new id.
    pub overwrite_name_conflicts: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub tunnels_added: usize,
    pub tunnels_updated: usize,
    pub rules_replaced: usize,
    pub secrets_restored: usize,
    pub known_hosts_added: usize,
}

fn decrypt_secrets(
    bundle: &ConfigBundle,
    passphrase: Option<&str>,
) -> Result<Option<HashMap<String, String>>, String> {
    let (Some(sealed), Some(passphrase)) = (&bundle.secrets, passphrase) else {
        return Ok(None);
    };
    if passphrase.is_empty() {
        return Ok(None);
    }
    let mut plaintext = open(sealed, passphrase)?;
    let map: HashMap<String, String> =
        serde_json::from_slice(&plaintext).map_err(|_| "corrupt secrets block".to_string())?;
    plaintext.zeroize();
    Ok(Some(map))
}

#[tauri::command]
pub async fn preview_import(
    state: State<'_, AppState>,
    path: String,
    passphrase: Option<String>,
) -> Result<ImportPreview, String> {
    let bundle = read_bundle(&path)?;
    let existing = state.db.list().map_err(|e| e.to_string())?;

    let tunnels = bundle
        .tunnels
        .iter()
        .map(|t| TunnelPreview {
            id: t.id,
            name: t.name.clone(),
            host: t.host.clone(),
            disposition: if existing.iter().any(|e| e.id == t.id) {
                TunnelDisposition::Overwrite
            } else if existing.iter().any(|e| e.name == t.name) {
                TunnelDisposition::NameConflict
            } else {
                TunnelDisposition::New
            },
        })
        .collect();

    // A wrong passphrase must not fail the whole preview — the user should still
    // see what else is in the file while they retype it.
    let secrets = decrypt_secrets(&bundle, passphrase.as_deref()).ok().flatten();

    Ok(ImportPreview {
        app_version: bundle.app_version,
        exported_at: bundle.exported_at,
        tunnels,
        router_rule_count: bundle.router_rules.len(),
        current_router_rule_count: state
            .db
            .list_router_rules()
            .map(|r| r.len())
            .unwrap_or(0),
        known_host_count: bundle.known_hosts.len(),
        has_secrets: bundle.secrets.is_some(),
        secrets_unlocked: secrets.is_some(),
        secret_count: secrets.map(|s| s.len()).unwrap_or(0),
    })
}

#[tauri::command]
pub async fn apply_import(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    passphrase: Option<String>,
    sections: ImportSections,
) -> Result<ImportResult, String> {
    let bundle = read_bundle(&path)?;
    let mut result = ImportResult::default();

    // Decrypt before writing anything: a wrong passphrase should abort the whole
    // import, not leave tunnels imported with no credentials.
    let secret_map = if sections.secrets {
        decrypt_secrets(&bundle, passphrase.as_deref())?
    } else {
        None
    };

    // Maps each id in the file to the id it ended up under, so router rules
    // never point at a tunnel that does not exist.
    let mut id_map: HashMap<Uuid, Uuid> = HashMap::new();

    if sections.tunnels {
        let existing = state.db.list().map_err(|e| e.to_string())?;
        for imported in &bundle.tunnels {
            let same_id = existing.iter().find(|e| e.id == imported.id);
            let same_name = existing.iter().find(|e| e.name == imported.name);

            let (target_id, is_update) = match (same_id, same_name) {
                (Some(e), _) => (e.id, true),
                (None, Some(e)) if sections.overwrite_name_conflicts => (e.id, true),
                (None, Some(_)) => (Uuid::new_v4(), false),
                (None, None) => (imported.id, false),
            };

            let mut tunnel = imported.clone();
            tunnel.id = target_id;
            if !is_update && same_name.is_some() {
                tunnel.name = format!("{} (imported)", imported.name);
            }
            tunnel.forwards = Vec::new();

            if is_update {
                state.db.update(&tunnel).map_err(|e| e.to_string())?;
                result.tunnels_updated += 1;
            } else {
                state.db.insert(&tunnel).map_err(|e| e.to_string())?;
                result.tunnels_added += 1;
            }

            // Forwards always get fresh ids: importing a copy would otherwise
            // collide with the original's rows on the primary key.
            let forwards: Vec<PortForward> = imported
                .forwards
                .iter()
                .map(|f| PortForward {
                    id: Uuid::new_v4(),
                    tunnel_id: target_id,
                    remote_host: f.remote_host.clone(),
                    remote_port: f.remote_port,
                    local_port: f.local_port,
                })
                .collect();
            state
                .db
                .replace_forwards(target_id, &forwards)
                .map_err(|e| e.to_string())?;

            id_map.insert(imported.id, target_id);
        }
    }

    if let Some(map) = secret_map {
        for (id, secret) in map {
            let Ok(original) = Uuid::parse_str(&id) else {
                continue;
            };
            // Only restore secrets for tunnels this import actually brought in.
            let target = id_map.get(&original).copied().unwrap_or(original);
            if secrets::set_secret(target, &secret).is_ok() {
                result.secrets_restored += 1;
            }
        }
    }

    if sections.router {
        let rules: Vec<RouterRule> = bundle
            .router_rules
            .iter()
            .map(|r| {
                let mut rule = r.clone();
                rule.target_tunnel_id = r
                    .target_tunnel_id
                    .map(|id| id_map.get(&id).copied().unwrap_or(id));
                rule
            })
            .collect();
        result.rules_replaced = rules.len();
        state
            .db
            .replace_router_rules(&rules)
            .map_err(|e| e.to_string())?;
        state.router.store.update(bundle.router_config.clone());
        crate::router::apply_change(&app, true).await?;
    }

    if sections.settings {
        state.settings.update(bundle.settings.clone());
        crate::commands::sync_autostart(&app, bundle.settings.autostart_enabled)?;
        let _ = app.emit(crate::events::SETTINGS_CHANGED_EVENT, &bundle.settings);
    }

    if sections.known_hosts {
        result.known_hosts_added = state.known_hosts.merge(bundle.known_hosts.clone());
    }

    crate::commands::tunnels_changed(&app);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_round_trip() {
        let sealed = seal(b"{\"a\":\"secret\"}", "correct horse").unwrap();
        let opened = open(&sealed, "correct horse").unwrap();
        assert_eq!(opened, b"{\"a\":\"secret\"}");
    }

    #[test]
    fn wrong_passphrase_is_reported_as_such() {
        let sealed = seal(b"payload", "right").unwrap();
        let err = open(&sealed, "wrong").unwrap_err();
        assert!(err.contains("wrong passphrase"), "got: {err}");
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let mut sealed = seal(b"payload", "pw").unwrap();
        let mut raw = BASE64.decode(&sealed.ciphertext).unwrap();
        raw[0] ^= 0xff;
        sealed.ciphertext = BASE64.encode(&raw);
        assert!(open(&sealed, "pw").is_err());
    }

    #[test]
    fn each_seal_uses_a_fresh_salt_and_nonce() {
        let a = seal(b"payload", "pw").unwrap();
        let b = seal(b"payload", "pw").unwrap();
        assert_ne!(a.salt, b.salt);
        assert_ne!(a.nonce, b.nonce);
        // Same plaintext and passphrase must not produce the same ciphertext.
        assert_ne!(a.ciphertext, b.ciphertext);
    }

    #[test]
    fn a_bundle_without_a_passphrase_serializes_no_secrets_key() {
        let bundle = ConfigBundle {
            format: FORMAT.to_string(),
            version: VERSION,
            exported_at: 0,
            app_version: "0.0.0".to_string(),
            tunnels: Vec::new(),
            router_config: RouterConfig::default(),
            router_rules: Vec::new(),
            settings: Settings::default(),
            known_hosts: Vec::new(),
            secrets: None,
        };
        let json = serde_json::to_string(&bundle).unwrap();
        assert!(!json.contains("secrets"), "{json}");
    }
}
