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
use rand::TryRng;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;
use zeroize::Zeroize;

use crate::db::{AuthMethod, Db, PortForward, Tunnel};
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
    /// "simple" when the exporter asked the file to open protunel in Simple
    /// mode (an administrator setting up a tester's machine). Independent of the
    /// settings section, so it doesn't drag the exporter's theme along.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_mode: Option<String>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn random_bytes(len: usize) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; len];
    rand::rngs::SysRng
        .try_fill_bytes(&mut buf)
        .map_err(|e| format!("failed to gather randomness: {e}"))?;
    Ok(buf)
}

/// Derive a 32-byte AES key using the original export format's Argon2id parameters.
/// The caller zeroizes the derived key once the cipher has been built.
fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    use argon2::{Algorithm, Argon2, Params, Version};

    let mut key = [0u8; 32];
    let params = Params::new(19 * 1024, 2, 1, Some(key.len()))
        .map_err(|e| format!("key derivation failed: {e}"))?;
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
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
    /// Ask the importing machine to switch to Simple mode.
    #[serde(default)]
    pub simple_mode: bool,
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
        ui_mode: sections.simple_mode.then(|| "simple".to_string()),
    })
}

fn read_bundle(path: &str) -> Result<ConfigBundle, String> {
    let data = std::fs::read_to_string(path).map_err(|e| format!("cannot read file: {e}"))?;
    parse_bundle(&data)
}

fn parse_bundle(data: &str) -> Result<ConfigBundle, String> {
    let bundle: ConfigBundle =
        serde_json::from_str(data).map_err(|e| format!("not a valid config file: {e}"))?;
    if bundle.format != FORMAT {
        return Err("not-a-config".to_string());
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
        .add_filter(crate::i18n::t(&app, crate::i18n::Text::FilterConfig), &["json"])
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
        .add_filter(crate::i18n::t(&app, crate::i18n::Text::FilterConfig), &["json"])
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
    /// The tunnel's private-key path, when that file does not exist on this
    /// machine. Only the path is exported, never the key, so a bundle moved
    /// between machines (or from Windows to Linux) can't connect until the
    /// user copies the key over and fixes the path.
    pub missing_key_path: Option<String>,
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
    /// The UI mode the file asks for, if any (see `ConfigBundle::ui_mode`).
    pub ui_mode: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSections {
    pub tunnels: bool,
    pub router: bool,
    pub settings: bool,
    pub known_hosts: bool,
    pub secrets: bool,
    /// Apply the file's `ui_mode`.
    #[serde(default)]
    pub ui_mode: bool,
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
            missing_key_path: match &t.auth {
                AuthMethod::PrivateKey { path } if !std::path::Path::new(path).is_file() => {
                    Some(path.clone())
                }
                _ => None,
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
        ui_mode: bundle.ui_mode,
    })
}

/// The tunnel half of `apply_import`, split out so it can be tested against a
/// plain `Db`. Returns the file-id to final-id map.
fn import_tunnels(
    db: &Db,
    tunnels: &[Tunnel],
    overwrite_name_conflicts: bool,
    result: &mut ImportResult,
) -> Result<HashMap<Uuid, Uuid>, String> {
    let mut id_map: HashMap<Uuid, Uuid> = HashMap::new();
    let existing = db.list().map_err(|e| e.to_string())?;
    for imported in tunnels {
        let same_id = existing.iter().find(|e| e.id == imported.id);
        let same_name = existing.iter().find(|e| e.name == imported.name);

        let (target_id, is_update) = match (same_id, same_name) {
            (Some(e), _) => (e.id, true),
            (None, Some(e)) if overwrite_name_conflicts => (e.id, true),
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
            db.update(&tunnel).map_err(|e| e.to_string())?;
            db.set_bookmarks(tunnel.id, &tunnel.bookmarks).map_err(|e| e.to_string())?;
            result.tunnels_updated += 1;
        } else {
            db.insert(&tunnel).map_err(|e| e.to_string())?;
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
        db.replace_forwards(target_id, &forwards)
            .map_err(|e| e.to_string())?;

        id_map.insert(imported.id, target_id);
    }

    // Second pass, once every row has its final id: a jump host imported
    // under a new id (a name conflict made it a copy) must take its
    // children with it, or they keep pointing at the original.
    for imported in tunnels {
        let Some(jump) = imported.jump_tunnel_id else { continue };
        let Some(&jump_target) = id_map.get(&jump) else { continue };
        let target_id = id_map[&imported.id];
        if jump_target == jump {
            continue;
        }
        if let Some(mut tunnel) = db.get(target_id).map_err(|e| e.to_string())? {
            tunnel.jump_tunnel_id = Some(jump_target);
            db.update(&tunnel).map_err(|e| e.to_string())?;
        }
    }
    Ok(id_map)
}

/// Points each rule's tunnel target at the id that tunnel ended up under.
fn remap_rules(rules: &[RouterRule], id_map: &HashMap<Uuid, Uuid>) -> Vec<RouterRule> {
    rules
        .iter()
        .map(|r| {
            let mut rule = r.clone();
            rule.target_tunnel_id = r
                .target_tunnel_id
                .map(|id| id_map.get(&id).copied().unwrap_or(id));
            rule
        })
        .collect()
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
    // Asking for secrets without a passphrase used to skip them silently, which
    // left imported tunnels unable to connect with no hint why. Skipping has to
    // be explicit (`sections.secrets = false`).
    let secret_map = if sections.secrets {
        if bundle.secrets.is_some() && passphrase.as_deref().unwrap_or("").is_empty() {
            return Err("passphrase required to restore secrets".to_string());
        }
        decrypt_secrets(&bundle, passphrase.as_deref())?
    } else {
        None
    };

    // Maps each id in the file to the id it ended up under, so router rules
    // never point at a tunnel that does not exist.
    let mut id_map: HashMap<Uuid, Uuid> = HashMap::new();

    if sections.tunnels {
        id_map = import_tunnels(
            &state.db,
            &bundle.tunnels,
            sections.overwrite_name_conflicts,
            &mut result,
        )?;
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
        let rules = remap_rules(&bundle.router_rules, &id_map);
        result.rules_replaced = rules.len();
        state
            .db
            .replace_router_rules(&rules)
            .map_err(|e| e.to_string())?;
        state.router.store.update(bundle.router_config.clone())?;
        crate::router::apply_change(&app, true).await?;
    }

    if sections.settings {
        // The mode belongs to the person, not the file: only `ui_mode` below
        // (an explicit choice by the exporter) changes it.
        let settings = state.settings.try_modify(|current| {
            let settings = Settings {
                ui_mode: current.ui_mode.clone(),
                ..bundle.settings.clone()
            };
            crate::commands::sync_autostart(&app, settings.autostart_enabled)?;
            Ok(settings)
        })?;
        let _ = app.emit(crate::events::SETTINGS_CHANGED_EVENT, &settings);
    }

    if sections.known_hosts {
        result.known_hosts_added = state.known_hosts.merge(bundle.known_hosts.clone());
    }

    // After the settings section, which would otherwise put the exporter's mode back.
    if let (true, Some(mode)) = (
        sections.ui_mode,
        &crate::settings::normalize_ui_mode(bundle.ui_mode.clone()),
    ) {
        let settings = state.settings.modify(|settings| settings.ui_mode = Some(mode.clone()))?;
        let _ = app.emit(crate::events::SETTINGS_CHANGED_EVENT, &settings);
        crate::tray::rebuild_menu(&app);
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
    fn opens_export_with_original_argon2_parameters() {
        let sealed = SealedSecrets {
            kdf: "argon2id".into(),
            salt: "MDEyMzQ1Njc4OWFiY2RlZg==".into(),
            nonce: "MDEyMzQ1Njc4OWFi".into(),
            ciphertext: "i6H7RECXEBOWTIATU2mL1ORprVjl/jF5qm2zNEoW".into(),
        };
        assert_eq!(open(&sealed, "legacy-test").unwrap(), b"legacy secrets");
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
            ui_mode: None,
        };
        let json = serde_json::to_string(&bundle).unwrap();
        assert!(!json.contains("secrets"), "{json}");
    }
}

/// The pure parts of `apply_import` against a real in-memory `Db`. Not covered
/// (needs an `AppHandle`): the secret vault write, router restart, settings
/// sync, autostart and tray rebuild.
#[cfg(test)]
mod import_tests {
    use super::*;
    use crate::router::rules::{RuleAction, RuleKind};
    use crate::ssh::known_hosts::KnownHosts;
    use std::path::Path;

    fn mem_db() -> Db {
        Db::open(Path::new(":memory:")).unwrap()
    }

    fn tunnel(name: &str, jump: Option<Uuid>) -> Tunnel {
        let id = Uuid::new_v4();
        Tunnel {
            id,
            name: name.to_string(),
            host: format!("{name}.example.com"),
            port: 22,
            username: "root".to_string(),
            auth: AuthMethod::Agent,
            local_socks_port: 1080,
            auto_connect: false,
            forwards: vec![PortForward {
                id: Uuid::new_v4(),
                tunnel_id: id,
                remote_host: "127.0.0.1".to_string(),
                remote_port: 5432,
                local_port: 15432,
            }],
            jump_tunnel_id: jump,
            socks_enabled: true,
            group: None,
            bookmarks: Vec::new(),
        }
    }

    /// bastion <- app <- inner
    fn chain() -> Vec<Tunnel> {
        let bastion = tunnel("bastion", None);
        let app = tunnel("app", Some(bastion.id));
        let inner = tunnel("inner", Some(app.id));
        vec![bastion, app, inner]
    }

    fn by_name(db: &Db, name: &str) -> Tunnel {
        db.list()
            .unwrap()
            .into_iter()
            .find(|t| t.name == name)
            .unwrap_or_else(|| panic!("no tunnel {name}"))
    }

    fn import(db: &Db, tunnels: &[Tunnel], overwrite: bool) -> (HashMap<Uuid, Uuid>, ImportResult) {
        let mut result = ImportResult::default();
        let map = import_tunnels(db, tunnels, overwrite, &mut result).unwrap();
        (map, result)
    }

    fn rule(target: Option<Uuid>) -> RouterRule {
        RouterRule {
            id: Uuid::new_v4(),
            position: 0,
            enabled: true,
            kind: RuleKind::HostWildcard,
            pattern: "*.corp".to_string(),
            port: None,
            action: RuleAction::Tunnel,
            target_tunnel_id: target,
        }
    }

    fn bundle_json(format: &str, version: u32) -> String {
        serde_json::to_string(&ConfigBundle {
            format: format.to_string(),
            version,
            exported_at: 0,
            app_version: "test".to_string(),
            tunnels: Vec::new(),
            router_config: RouterConfig::default(),
            router_rules: Vec::new(),
            settings: Settings::default(),
            known_hosts: Vec::new(),
            secrets: None,
            ui_mode: None,
        })
        .unwrap()
    }

    #[test]
    fn parse_bundle_accepts_current_and_refuses_newer_or_foreign() {
        assert!(parse_bundle(&bundle_json(FORMAT, VERSION)).is_ok());
        let newer = parse_bundle(&bundle_json(FORMAT, VERSION + 1)).err().unwrap();
        assert!(newer.contains("newer version"), "{newer}");
        let foreign = parse_bundle(&bundle_json("something-else", VERSION)).err().unwrap();
        assert!(foreign == "not-a-config", "{foreign}");
        let junk = parse_bundle("{}").err().unwrap();
        assert!(junk.contains("not a valid config file"), "{junk}");
    }

    #[test]
    fn import_into_empty_db_keeps_ids_chain_and_gives_forwards_fresh_ids() {
        let tunnels = chain();
        let db = mem_db();
        let (map, result) = import(&db, &tunnels, false);
        assert_eq!((result.tunnels_added, result.tunnels_updated), (3, 0));
        for t in &tunnels {
            assert_eq!(map[&t.id], t.id, "no conflict: ids unchanged");
        }
        let bastion = by_name(&db, "bastion");
        let app = by_name(&db, "app");
        assert_eq!(app.jump_tunnel_id, Some(bastion.id));
        assert_eq!(by_name(&db, "inner").jump_tunnel_id, Some(app.id));

        assert_eq!(app.forwards.len(), 1);
        let f = &app.forwards[0];
        assert_ne!(f.id, tunnels[1].forwards[0].id, "forward id must be fresh");
        assert_eq!(f.tunnel_id, app.id);
        assert_eq!((f.remote_port, f.local_port), (5432, 15432));
    }

    #[test]
    fn name_conflict_import_makes_a_copy_and_moves_children() {
        let tunnels = chain();
        let db = mem_db();
        let mut existing = tunnel("bastion", None);
        existing.forwards.clear();
        db.insert(&existing).unwrap();

        let (map, result) = import(&db, &tunnels, false);
        assert_eq!((result.tunnels_added, result.tunnels_updated), (3, 0));
        let copy_id = map[&tunnels[0].id];
        assert_ne!(copy_id, tunnels[0].id);
        assert_ne!(copy_id, existing.id);
        assert_eq!(db.get(copy_id).unwrap().unwrap().name, "bastion (imported)");
        assert_eq!(db.get(existing.id).unwrap().unwrap().name, "bastion");

        let app = by_name(&db, "app");
        assert_eq!(app.jump_tunnel_id, Some(copy_id), "child follows the copy");
        assert_eq!(by_name(&db, "inner").jump_tunnel_id, Some(app.id));
    }

    #[test]
    fn overwrite_name_conflicts_updates_in_place() {
        let tunnels = chain();
        let db = mem_db();
        let mut existing = tunnel("bastion", None);
        existing.host = "stale.example.com".into();
        existing.forwards.clear();
        db.insert(&existing).unwrap();

        let (map, result) = import(&db, &tunnels, true);
        assert_eq!((result.tunnels_added, result.tunnels_updated), (2, 1));
        assert_eq!(map[&tunnels[0].id], existing.id, "mapped onto the existing row");
        assert_eq!(db.list().unwrap().len(), 3);
        assert_eq!(db.get(existing.id).unwrap().unwrap().host, "bastion.example.com");
        assert_eq!(by_name(&db, "app").jump_tunnel_id, Some(existing.id));
    }

    #[test]
    fn reimporting_updates_and_does_not_duplicate_forwards() {
        let tunnels = chain();
        let db = mem_db();
        import(&db, &tunnels, false);
        let (map, result) = import(&db, &tunnels, false);
        assert_eq!((result.tunnels_added, result.tunnels_updated), (0, 3));
        for t in &tunnels {
            assert_eq!(map[&t.id], t.id);
        }
        assert_eq!(db.list().unwrap().len(), 3);
        assert_eq!(by_name(&db, "app").forwards.len(), 1, "forwards replaced, not appended");
        assert_eq!(by_name(&db, "app").jump_tunnel_id, Some(tunnels[0].id));
    }

    #[test]
    fn remap_rules_follows_the_id_map_and_leaves_unknown_targets() {
        let old = Uuid::new_v4();
        let new = Uuid::new_v4();
        let stranger = Uuid::new_v4();
        let rules = vec![rule(Some(old)), rule(Some(stranger)), rule(None)];
        let map = HashMap::from([(old, new)]);
        let out = remap_rules(&rules, &map);
        assert_eq!(out[0].target_tunnel_id, Some(new));
        assert_eq!(out[1].target_tunnel_id, Some(stranger));
        assert_eq!(out[2].target_tunnel_id, None);
    }

    struct TempFile(std::path::PathBuf);
    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn key(k: &str) -> TrustedKey {
        TrustedKey {
            openssh_key: k.to_string(),
            fingerprint: "SHA256:x".to_string(),
            algorithm: "ssh-ed25519".to_string(),
            trusted_at: 0,
        }
    }

    #[test]
    fn known_hosts_merge_keeps_the_existing_key() {
        let path = std::env::temp_dir().join(format!("protunel-known-{}.json", Uuid::new_v4()));
        let _guard = TempFile(path.clone());
        let known = KnownHosts::load(path);
        known.trust("a:22", "ssh-ed25519 LOCAL", "SHA256:local", "ssh-ed25519");

        let incoming = vec![
            ("a:22".to_string(), key("ssh-ed25519 OTHER")),
            ("b:22".to_string(), key("ssh-ed25519 NEW")),
        ];
        assert_eq!(known.merge(incoming.clone()), 1, "only the unknown host is added");
        assert_eq!(known.openssh_key("a:22").as_deref(), Some("ssh-ed25519 LOCAL"));
        assert_eq!(known.openssh_key("b:22").as_deref(), Some("ssh-ed25519 NEW"));
        assert_eq!(known.merge(incoming), 0);
    }
}
