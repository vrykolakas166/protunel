//! Import of WinSCP sessions (an exported `WinSCP.ini`) as hosts.
//!
//! Two steps, both in Rust: `winscp_preview` opens the file dialog, parses
//! the file and keeps the parse in memory behind a short-lived token; the
//! webview gets names, targets and statuses, never a password. `winscp_import`
//! then imports the rows the user kept, decoding each password only at that
//! moment and writing it straight into the OS vault.
//!
//! WinSCP without a master password stores passwords obfuscated, not
//! encrypted: XOR with a constant, keyed by user + host. A file that uses a
//! master password is refused. Host keys are never imported as trusted: a
//! new host goes through the normal first-connection prompt (TOFU).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;
use zeroize::Zeroize;

use crate::db::{AuthMethod, Tunnel};
use crate::secrets;
use crate::AppState;

/// How long a preview stays importable.
const PREVIEW_TTL: Duration = Duration::from_secs(15 * 60);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// One endpoint as WinSCP stores it: a session's host, or its tunnel.
#[derive(Debug, Clone, PartialEq)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// Obfuscated password field, decoded only on import.
    pub password: Option<String>,
    pub key_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Session {
    /// Full name with folders, e.g. "PT/root@10.1.1.16".
    pub path: String,
    pub endpoint: Endpoint,
    pub tunnel: Option<Endpoint>,
    pub remote_dir: Option<String>,
    /// FSProtocol: SCP/SFTP are SSH; FTP, WebDAV and S3 are not.
    pub ssh: bool,
}

impl Session {
    /// Folders joined into one group label: "PT", "PT / QA", or none.
    pub fn group(&self) -> Option<String> {
        let mut parts: Vec<&str> = self.path.split('/').collect();
        parts.pop();
        let parts: Vec<&str> = parts.into_iter().map(str::trim).filter(|p| !p.is_empty()).collect();
        (!parts.is_empty()).then(|| parts.join(" / "))
    }

    /// The last path segment, the name WinSCP shows.
    pub fn name(&self) -> String {
        self.path.rsplit('/').next().unwrap_or(&self.path).trim().to_string()
    }
}

/// WinSCP escapes some characters as `%XX` in section names and values.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Sections of an INI file, keys as written (WinSCP keys are case-sensitive).
fn parse_ini(text: &str) -> Vec<(String, HashMap<String, String>)> {
    let mut sections: Vec<(String, HashMap<String, String>)> = Vec::new();
    for line in text.lines() {
        let line = line.trim_start_matches('\u{feff}').trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            sections.push((name.to_string(), HashMap::new()));
        } else if let (Some((key, value)), Some(section)) = (line.split_once('='), sections.last_mut()) {
            section.1.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    sections
}

pub enum Parsed {
    Sessions(Vec<Session>),
    MasterPassword,
}

pub fn parse(text: &str) -> Parsed {
    let sections = parse_ini(text);
    let master = sections.iter().any(|(name, keys)| {
        name.eq_ignore_ascii_case("Configuration\\Security")
            && keys.get("UseMasterPassword").is_some_and(|v| v == "1")
    });
    if master {
        return Parsed::MasterPassword;
    }
    let get = |keys: &HashMap<String, String>, key: &str| {
        keys.get(key).map(|v| percent_decode(v)).filter(|v| !v.is_empty())
    };
    let sessions = sections
        .iter()
        .filter_map(|(name, keys)| {
            let rest = name.strip_prefix("Sessions\\").or_else(|| name.strip_prefix("sessions\\"))?;
            let host = get(keys, "HostName")?;
            let tunnel = (keys.get("Tunnel").map(String::as_str) == Some("1"))
                .then(|| {
                    Some(Endpoint {
                        host: get(keys, "TunnelHostName")?,
                        port: get(keys, "TunnelPortNumber").and_then(|p| p.parse().ok()).unwrap_or(22),
                        user: get(keys, "TunnelUserName").unwrap_or_default(),
                        password: keys.get("TunnelPassword").cloned().filter(|v| !v.is_empty()),
                        key_path: get(keys, "TunnelPublicKeyFile"),
                    })
                })
                .flatten();
            // 0 SCP, 1 SFTP (SCP fallback), 2 SFTP: SSH. 5 FTP, 6 WebDAV, 7 S3: not.
            let ssh = keys
                .get("FSProtocol")
                .and_then(|p| p.parse::<u8>().ok())
                .is_none_or(|p| p <= 2);
            Some(Session {
                path: percent_decode(rest),
                endpoint: Endpoint {
                    host,
                    port: get(keys, "PortNumber").and_then(|p| p.parse().ok()).unwrap_or(22),
                    user: get(keys, "UserName").unwrap_or_default(),
                    password: keys.get("Password").cloned().filter(|v| !v.is_empty()),
                    key_path: get(keys, "PublicKeyFile"),
                },
                tunnel,
                remote_dir: get(keys, "RemoteDirectory"),
                ssh,
            })
        })
        .collect();
    Parsed::Sessions(sessions)
}

/// WinSCP's password storage without a master password. `key` is
/// user + host of the endpoint the password belongs to.
pub fn decode_password(encoded: &str, key: &str) -> Result<String, &'static str> {
    if encoded.len() % 2 != 0 || !encoded.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("not WinSCP password data");
    }
    let data: Vec<u8> = (0..encoded.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&encoded[i..i + 2], 16).unwrap_or(0))
        .collect();
    let mut pos = 0;
    let mut next = || -> Result<u8, &'static str> {
        let b = *data.get(pos).ok_or("truncated password")?;
        pos += 1;
        Ok(!(b ^ 0xA3))
    };
    let flag = next()?;
    let length = if flag == 0xFF {
        match next()? {
            0 => next()? as usize,
            2 => ((next()? as usize) << 8) | next()? as usize,
            1 => return Err("master-password encryption"),
            _ => return Err("unsupported password version"),
        }
    } else {
        flag as usize
    };
    let shift = next()? as usize;
    for _ in 0..shift {
        next()?;
    }
    let mut payload = Vec::with_capacity(length);
    for _ in 0..length {
        payload.push(next()?);
    }
    if flag == 0xFF {
        let prefix = key.as_bytes();
        if !payload.starts_with(prefix) {
            payload.zeroize();
            return Err("password does not match its host");
        }
        payload.drain(..prefix.len());
    }
    String::from_utf8(payload).map_err(|e| {
        let mut bytes = e.into_bytes();
        bytes.zeroize();
        "password is not text"
    })
}

fn decode_endpoint_password(endpoint: &Endpoint) -> Result<Option<String>, &'static str> {
    match &endpoint.password {
        None => Ok(None),
        Some(enc) => decode_password(enc, &format!("{}{}", endpoint.user, endpoint.host)).map(Some),
    }
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Warning {
    /// The session's name names another host than it connects to.
    NameHost { named: String },
    /// The name says `user@` but it logs in as someone else.
    NameUser { named: String },
    NoPassword,
    PasswordUnreadable,
    KeyPathMissing { path: String },
    /// Sessions through this jump host saved different credentials for it.
    BastionCredentialsDiffer,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RowStatus {
    New,
    /// Already a host here (same target and route).
    Existing { id: Uuid, name: String, group: Option<String> },
    /// Not SSH (FTP, WebDAV, S3): cannot be imported.
    Unsupported,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRow {
    pub index: usize,
    pub name: String,
    pub group: Option<String>,
    pub target: String,
    pub remote_dir: Option<String>,
    pub status: RowStatus,
    /// Index into `bastions`, for a session through a jump host.
    pub bastion: Option<usize>,
    pub warnings: Vec<Warning>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: Uuid,
    pub name: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BastionPreview {
    pub index: usize,
    pub target: String,
    /// Existing hosts with this endpoint (no jump of their own). Empty: it
    /// will be created. More than one: the user picks.
    pub candidates: Vec<Candidate>,
    pub warnings: Vec<Warning>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WinscpPreview {
    pub token: String,
    pub file_name: String,
    pub rows: Vec<PreviewRow>,
    pub bastions: Vec<BastionPreview>,
}

fn target(e: &Endpoint) -> String {
    format!("{}@{}:{}", e.user, e.host, e.port)
}

fn same_endpoint(t: &Tunnel, e: &Endpoint) -> bool {
    t.host.eq_ignore_ascii_case(&e.host) && t.port == e.port && t.username == e.user
}

/// Distinct jump endpoints, in first-seen order.
fn bastion_endpoints(sessions: &[Session]) -> Vec<Endpoint> {
    let mut out: Vec<Endpoint> = Vec::new();
    for tunnel in sessions.iter().filter_map(|s| s.tunnel.as_ref()) {
        if !out.iter().any(|b| endpoint_key(b) == endpoint_key(tunnel)) {
            out.push(tunnel.clone());
        }
    }
    out
}

fn endpoint_key(e: &Endpoint) -> (String, u16, String) {
    (e.host.to_ascii_lowercase(), e.port, e.user.clone())
}

/// Name-vs-target mismatches worth a look: "root@10.1.10.51" connecting to
/// 10.1.10.45, or "admin@…" logging in as root.
fn name_warnings(name: &str, e: &Endpoint) -> Vec<Warning> {
    let mut out = Vec::new();
    let (user, rest) = match name.split_once('@') {
        Some((u, r)) => (Some(u), r),
        None => (None, name),
    };
    if let Some(user) = user {
        if !user.is_empty() && user != e.user {
            out.push(Warning::NameUser { named: user.to_string() });
        }
    }
    let rest = rest.split(':').next().unwrap_or(rest);
    let looks_like_host = rest.contains('.') && !rest.contains(' ');
    if looks_like_host && !rest.eq_ignore_ascii_case(&e.host) {
        out.push(Warning::NameHost { named: rest.to_string() });
    }
    out
}

fn key_warning(e: &Endpoint) -> Option<Warning> {
    let path = e.key_path.as_ref()?;
    (!std::path::Path::new(path).exists()).then(|| Warning::KeyPathMissing { path: path.clone() })
}

/// The host already here for a session: same target and the same route
/// (through a jump host at the session's tunnel endpoint, or direct).
fn find_existing<'a>(s: &Session, existing: &'a [Tunnel], byid: &HashMap<Uuid, &Tunnel>) -> Option<&'a Tunnel> {
    existing.iter().find(|t| {
        same_endpoint(t, &s.endpoint)
            && match (&s.tunnel, t.jump_tunnel_id.and_then(|j| byid.get(&j))) {
                (Some(tun), Some(jump)) => same_endpoint(jump, tun),
                (None, None) => t.jump_tunnel_id.is_none(),
                _ => false,
            }
    })
}

pub fn build_preview(sessions: &[Session], existing: &[Tunnel], token: String, file_name: String) -> WinscpPreview {
    let byid: HashMap<Uuid, &Tunnel> = existing.iter().map(|t| (t.id, t)).collect();
    let endpoints = bastion_endpoints(sessions);
    let bastions: Vec<BastionPreview> = endpoints
        .iter()
        .enumerate()
        .map(|(index, e)| {
            let candidates = existing
                .iter()
                .filter(|t| t.jump_tunnel_id.is_none() && same_endpoint(t, e))
                .map(|t| Candidate { id: t.id, name: t.name.clone() })
                .collect();
            // Compared decoded: WinSCP pads each encoding at random, so one
            // password never encodes the same way twice. Wiped right after.
            let mut passwords: Vec<Option<String>> = sessions
                .iter()
                .filter_map(|s| s.tunnel.as_ref())
                .filter(|t| endpoint_key(t) == endpoint_key(e))
                .map(|t| decode_endpoint_password(t).ok().flatten())
                .collect();
            let mut warnings: Vec<Warning> = key_warning(e).into_iter().collect();
            if passwords.windows(2).any(|w| w[0] != w[1]) {
                warnings.push(Warning::BastionCredentialsDiffer);
            }
            for p in passwords.iter_mut().flatten() {
                p.zeroize();
            }
            BastionPreview { index, target: target(e), candidates, warnings }
        })
        .collect();

    let rows = sessions
        .iter()
        .enumerate()
        .map(|(index, s)| {
            let e = &s.endpoint;
            let bastion = s
                .tunnel
                .as_ref()
                .and_then(|t| endpoints.iter().position(|b| endpoint_key(b) == endpoint_key(t)));
            let status = if !s.ssh {
                RowStatus::Unsupported
            } else {
                match find_existing(s, existing, &byid) {
                    Some(t) => RowStatus::Existing { id: t.id, name: t.name.clone(), group: t.group.clone() },
                    None => RowStatus::New,
                }
            };
            let mut warnings = name_warnings(&s.name(), e);
            if e.password.is_none() && e.key_path.is_none() {
                warnings.push(Warning::NoPassword);
            } else if e.password.is_some() && decode_endpoint_password(e).is_err() {
                warnings.push(Warning::PasswordUnreadable);
            }
            warnings.extend(key_warning(e));
            PreviewRow {
                index,
                name: s.name(),
                group: s.group(),
                target: target(e),
                remote_dir: s.remote_dir.clone(),
                status,
                bastion,
                warnings,
            }
        })
        .collect();
    WinscpPreview { token, file_name, rows, bastions }
}

// ---------------------------------------------------------------------------
// The parse kept between preview and import
// ---------------------------------------------------------------------------

struct Pending {
    token: String,
    sessions: Vec<Session>,
    at: Instant,
}

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

#[tauri::command]
pub async fn winscp_preview(app: AppHandle, state: State<'_, AppState>) -> Result<Option<WinscpPreview>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("WinSCP.ini", &["ini"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx.await.map_err(|_| "file dialog closed".to_string())? else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| format!("unusable path: {e}"))?;
    let bytes = std::fs::read(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let text = String::from_utf8_lossy(&bytes);
    let sessions = match parse(&text) {
        Parsed::MasterPassword => return Err("master-password".to_string()),
        Parsed::Sessions(s) if s.is_empty() => return Err("no-sessions".to_string()),
        Parsed::Sessions(s) => s,
    };
    let existing = state.db.list().map_err(|e| e.to_string())?;
    let token = Uuid::new_v4().to_string();
    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let preview = build_preview(&sessions, &existing, token.clone(), file_name);
    *PENDING.lock().unwrap() = Some(Pending { token, sessions, at: Instant::now() });
    Ok(Some(preview))
}

/// Drops the kept parse (Cancel, Back, or picking another file).
#[tauri::command]
pub fn winscp_cancel(token: String) {
    let mut pending = PENDING.lock().unwrap();
    if pending.as_ref().is_some_and(|p| p.token == token) {
        *pending = None;
    }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum RowAction {
    /// Create the host.
    Add,
    /// An existing host: only file it under the session's group.
    SetGroup,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RowChoice {
    pub index: usize,
    pub action: RowAction,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BastionChoice {
    pub index: usize,
    /// An existing host to use; None creates one.
    pub use_tunnel: Option<Uuid>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub token: String,
    pub rows: Vec<RowChoice>,
    pub bastions: Vec<BastionChoice>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub name: String,
    pub error: String,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub added: usize,
    pub grouped: usize,
    pub bastions_created: usize,
    pub failed: Vec<Failure>,
    pub groups: Vec<String>,
}

fn auth_for(e: &Endpoint) -> AuthMethod {
    match &e.key_path {
        Some(path) => AuthMethod::PrivateKey { path: path.clone() },
        None => AuthMethod::Password,
    }
}

/// Inserts a host and its password; a failed vault write takes the row back
/// out, so no host is left without the credential it was imported with.
fn insert_with_secret(state: &AppState, tunnel: &Tunnel, endpoint: &Endpoint) -> Result<(), String> {
    let password = decode_endpoint_password(endpoint).ok().flatten();
    state.db.insert(tunnel).map_err(|e| e.to_string())?;
    if let Some(mut password) = password {
        let stored = secrets::set_secret(tunnel.id, &password);
        password.zeroize();
        if let Err(e) = stored {
            let _ = state.db.delete(tunnel.id);
            return Err(format!("credential vault: {e}"));
        }
    }
    Ok(())
}

fn new_tunnel(name: String, e: &Endpoint, jump: Option<Uuid>, group: Option<String>) -> Tunnel {
    Tunnel {
        id: Uuid::new_v4(),
        name,
        host: e.host.clone(),
        port: e.port,
        username: e.user.clone(),
        auth: auth_for(e),
        local_socks_port: 1080,
        auto_connect: false,
        forwards: Vec::new(),
        jump_tunnel_id: jump,
        // Terminal hosts: the router reaches them without a SOCKS port.
        socks_enabled: false,
        group,
        bookmarks: Vec::new(),
    }
}

#[tauri::command]
pub async fn winscp_import(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ImportRequest,
) -> Result<ImportOutcome, String> {
    let sessions = {
        let mut pending = PENDING.lock().unwrap();
        match pending.take() {
            Some(p) if p.token == request.token && p.at.elapsed() < PREVIEW_TTL => p.sessions,
            other => {
                *pending = other.filter(|p| p.token != request.token);
                return Err("expired".to_string());
            }
        }
    };
    let state = state.inner();
    let existing = state.db.list().map_err(|e| e.to_string())?;
    let endpoints = bastion_endpoints(&sessions);
    let mut outcome = ImportOutcome::default();
    let mut groups: Vec<String> = Vec::new();
    let mut note_group = |g: &Option<String>| {
        if let Some(g) = g {
            if !groups.iter().any(|x| x.eq_ignore_ascii_case(g)) {
                groups.push(g.clone());
            }
        }
    };

    let adds: Vec<&Session> = request
        .rows
        .iter()
        .filter(|r| r.action == RowAction::Add)
        .filter_map(|r| sessions.get(r.index))
        .filter(|s| s.ssh)
        .collect();

    // Jump hosts first: each one a selected row needs, used or created once.
    // A failed one blocks the rows that go through it.
    let mut bastion_ids: HashMap<usize, Result<Uuid, String>> = HashMap::new();
    for (index, endpoint) in endpoints.iter().enumerate() {
        let users: Vec<&&Session> = adds
            .iter()
            .filter(|s| s.tunnel.as_ref().is_some_and(|t| endpoint_key(t) == endpoint_key(endpoint)))
            .collect();
        if users.is_empty() {
            continue;
        }
        let chosen = request.bastions.iter().find(|b| b.index == index).and_then(|b| b.use_tunnel);
        let result = match chosen {
            Some(id) if existing.iter().any(|t| t.id == id && same_endpoint(t, endpoint)) => Ok(id),
            Some(_) => Err("the chosen jump host changed; preview again".to_string()),
            None => {
                // Filed under its sessions' group when they all share one.
                let first = users[0].group();
                let group = users.iter().all(|s| s.group() == first).then_some(first).flatten();
                let tunnel = new_tunnel(format!("{}@{}", endpoint.user, endpoint.host), endpoint, None, group.clone());
                insert_with_secret(state, &tunnel, endpoint).map(|_| {
                    outcome.bastions_created += 1;
                    note_group(&group);
                    tunnel.id
                })
            }
        };
        if let Err(error) = &result {
            outcome.failed.push(Failure { name: target(endpoint), error: error.clone() });
        }
        bastion_ids.insert(index, result);
    }

    for choice in &request.rows {
        let Some(session) = sessions.get(choice.index).filter(|s| s.ssh) else { continue };
        match choice.action {
            RowAction::SetGroup => {
                let byid: HashMap<Uuid, &Tunnel> = existing.iter().map(|t| (t.id, t)).collect();
                let Some(found) = find_existing(session, &existing, &byid) else { continue };
                let group = session.group();
                if let Err(err) = state.db.set_group(&[found.id], group.as_deref()) {
                    outcome.failed.push(Failure { name: session.name(), error: err.to_string() });
                } else {
                    outcome.grouped += 1;
                    note_group(&group);
                }
            }
            RowAction::Add => {
                let jump = match &session.tunnel {
                    None => None,
                    Some(t) => {
                        let index = endpoints.iter().position(|b| endpoint_key(b) == endpoint_key(t));
                        match index.and_then(|i| bastion_ids.get(&i)) {
                            Some(Ok(id)) => Some(*id),
                            _ => {
                                outcome.failed.push(Failure {
                                    name: session.name(),
                                    error: format!("jump host {} was not imported", target(t)),
                                });
                                continue;
                            }
                        }
                    }
                };
                let group = session.group();
                let mut tunnel = new_tunnel(session.name(), &session.endpoint, jump, group.clone());
                tunnel.bookmarks = session.remote_dir.iter().cloned().collect();
                match insert_with_secret(state, &tunnel, &session.endpoint) {
                    Ok(()) => {
                        outcome.added += 1;
                        note_group(&group);
                    }
                    Err(error) => outcome.failed.push(Failure { name: session.name(), error }),
                }
            }
        }
    }
    outcome.groups = groups;
    crate::commands::tunnels_changed(&app);
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// WinSCP's encoder, for round trips (the format is what WinSCP writes).
    fn encode(password: &str, key: &str) -> String {
        let payload = format!("{key}{password}");
        let mut bytes = vec![0xFFu8, 0, payload.len() as u8, 0];
        bytes.extend(payload.as_bytes());
        bytes.iter().map(|b| format!("{:02X}", !b ^ 0xA3)).collect()
    }

    #[test]
    fn decodes_what_winscp_encodes() {
        let enc = encode("s3cret", "rootexample.com");
        assert_eq!(decode_password(&enc, "rootexample.com").unwrap(), "s3cret");
        assert!(decode_password(&enc, "adminexample.com").is_err(), "keyed by user + host");
        assert!(decode_password("zz", "x").is_err());
    }

    const INI: &str = "\
[Sessions\\PT/root@10.1.1.16]
HostName=10.1.1.16
UserName=root
RemoteDirectory=/opt/app
LocalDirectory=C:%5CUsers%5Cx
Tunnel=1
TunnelHostName=192.168.166.128
TunnelUserName=administrator

[Sessions\\PT/root@10.1.10.51]
HostName=10.1.10.45
UserName=root
Tunnel=1
TunnelHostName=192.168.166.128
TunnelUserName=administrator

[Sessions\\VMS_DEV/elc@103.21.151.177]
HostName=103.21.151.177
PortNumber=10422
UserName=elc

[Sessions\\ftp%20site]
HostName=ftp.example.com
FSProtocol=5
";

    fn sessions() -> Vec<Session> {
        match parse(INI) {
            Parsed::Sessions(s) => s,
            Parsed::MasterPassword => panic!(),
        }
    }

    #[test]
    fn parses_sessions_folders_and_tunnels() {
        let s = sessions();
        assert_eq!(s.len(), 4);
        assert_eq!(s[0].group().as_deref(), Some("PT"));
        assert_eq!(s[0].name(), "root@10.1.1.16");
        assert_eq!(s[0].tunnel.as_ref().unwrap().port, 22);
        assert_eq!(s[0].remote_dir.as_deref(), Some("/opt/app"));
        assert_eq!(s[2].endpoint.port, 10422);
        assert_eq!(s[3].path, "ftp site");
        assert!(!s[3].ssh);
        assert!(matches!(
            parse("[Configuration\\Security]\nUseMasterPassword=1\n"),
            Parsed::MasterPassword
        ));
    }

    #[test]
    fn preview_matches_existing_hosts_and_bastions_and_flags_mismatches() {
        let bastion = Tunnel {
            id: Uuid::new_v4(),
            name: "VPNPhuTho".into(),
            host: "192.168.166.128".into(),
            port: 22,
            username: "administrator".into(),
            auth: AuthMethod::Password,
            local_socks_port: 1080,
            auto_connect: false,
            forwards: vec![],
            jump_tunnel_id: None,
            socks_enabled: false,
            group: None,
            bookmarks: vec![],
        };
        let known = Tunnel {
            id: Uuid::new_v4(),
            name: "10.1.1.16".into(),
            host: "10.1.1.16".into(),
            username: "root".into(),
            jump_tunnel_id: Some(bastion.id),
            ..bastion.clone()
        };
        let p = build_preview(&sessions(), &[bastion.clone(), known.clone()], "t".into(), "WinSCP.ini".into());
        assert_eq!(p.bastions.len(), 1);
        assert_eq!(p.bastions[0].candidates.len(), 1);
        assert!(matches!(&p.rows[0].status, RowStatus::Existing { id, .. } if *id == known.id));
        assert!(matches!(p.rows[1].status, RowStatus::New));
        assert!(p.rows[1].warnings.contains(&Warning::NameHost { named: "10.1.10.51".into() }));
        assert!(p.rows[1].warnings.contains(&Warning::NoPassword));
        assert!(matches!(p.rows[3].status, RowStatus::Unsupported));
    }
}

#[cfg(test)]
mod real_file {
    /// `WINSCP_INI=/path cargo test --lib winscp::real_file -- --ignored --nocapture`:
    /// previews a real file against nothing existing. Prints no secrets.
    #[test]
    #[ignore]
    fn preview_real_file() {
        let Ok(path) = std::env::var("WINSCP_INI") else { return };
        let text = std::fs::read_to_string(path).unwrap();
        let super::Parsed::Sessions(s) = super::parse(&text) else { panic!("master password") };
        let p = super::build_preview(&s, &[], "t".into(), "x".into());
        println!("sessions {} bastions {}", p.rows.len(), p.bastions.len());
        for b in &p.bastions {
            println!("bastion {} {:?}", b.target, b.warnings);
        }
        for r in &p.rows {
            println!("{:?} | {} | {} | {:?} | {:?}", r.group, r.name, r.target, r.bastion, r.warnings);
        }
    }
}
