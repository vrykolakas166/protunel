use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use uuid::Uuid;

use crate::router::rules::{RouterRule, RuleAction, RuleKind};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AuthMethod {
    Password,
    PrivateKey { path: String },
    Agent,
}

impl AuthMethod {
    fn kind(&self) -> &'static str {
        match self {
            AuthMethod::Password => "password",
            AuthMethod::PrivateKey { .. } => "private_key",
            AuthMethod::Agent => "agent",
        }
    }

    fn key_path(&self) -> Option<&str> {
        match self {
            AuthMethod::PrivateKey { path } => Some(path.as_str()),
            _ => None,
        }
    }

    fn from_row(kind: &str, key_path: Option<String>) -> Self {
        match kind {
            "private_key" => AuthMethod::PrivateKey {
                path: key_path.unwrap_or_default(),
            },
            "agent" => AuthMethod::Agent,
            _ => AuthMethod::Password,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tunnel {
    pub id: Uuid,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    pub local_socks_port: u16,
    pub auto_connect: bool,
    #[serde(default)]
    pub forwards: Vec<PortForward>,
    #[serde(default)]
    pub jump_tunnel_id: Option<Uuid>,
    #[serde(default = "default_socks_enabled")]
    pub socks_enabled: bool,
}

fn default_socks_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForward {
    pub id: Uuid,
    pub tunnel_id: Uuid,
    pub remote_host: String,
    pub remote_port: u16,
    pub local_port: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardInput {
    pub remote_host: String,
    pub remote_port: u16,
    pub local_port: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInput {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    pub local_socks_port: u16,
    pub auto_connect: bool,
    #[serde(default)]
    pub jump_tunnel_id: Option<Uuid>,
    #[serde(default = "default_socks_enabled")]
    pub socks_enabled: bool,
}

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS tunnels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL,
        auth_kind TEXT NOT NULL,
        auth_key_path TEXT,
        local_socks_port INTEGER NOT NULL,
        auto_connect INTEGER NOT NULL DEFAULT 0,
        jump_tunnel_id TEXT,
        socks_enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS port_forwards (
        id TEXT PRIMARY KEY,
        tunnel_id TEXT NOT NULL,
        remote_host TEXT NOT NULL,
        remote_port INTEGER NOT NULL,
        local_port INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS router_rules (
        id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        kind TEXT NOT NULL,
        pattern TEXT NOT NULL,
        port INTEGER,
        action TEXT NOT NULL,
        target_tunnel_id TEXT
    );
";

fn migrate(conn: &Connection) {
    let _ = conn.execute("ALTER TABLE tunnels ADD COLUMN jump_tunnel_id TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE tunnels ADD COLUMN socks_enabled INTEGER NOT NULL DEFAULT 1",
        [],
    );
}

const FORWARD_COLUMNS: &str = "id, tunnel_id, remote_host, remote_port, local_port";

fn row_to_forward(row: &rusqlite::Row) -> rusqlite::Result<PortForward> {
    let id: String = row.get(0)?;
    let tunnel_id: String = row.get(1)?;
    Ok(PortForward {
        id: Uuid::parse_str(&id).unwrap_or_else(|_| Uuid::nil()),
        tunnel_id: Uuid::parse_str(&tunnel_id).unwrap_or_else(|_| Uuid::nil()),
        remote_host: row.get(2)?,
        remote_port: row.get(3)?,
        local_port: row.get(4)?,
    })
}

const RULE_COLUMNS: &str =
    "id, position, enabled, kind, pattern, port, action, target_tunnel_id";

fn row_to_rule(row: &rusqlite::Row) -> rusqlite::Result<RouterRule> {
    let id: String = row.get(0)?;
    let kind: String = row.get(3)?;
    let action: String = row.get(6)?;
    let target_tunnel_id: Option<String> = row.get(7)?;
    Ok(RouterRule {
        id: Uuid::parse_str(&id).unwrap_or_else(|_| Uuid::nil()),
        position: row.get(1)?,
        enabled: row.get(2)?,
        kind: RuleKind::from_str(&kind),
        pattern: row.get(4)?,
        port: row.get(5)?,
        action: RuleAction::from_str(&action),
        target_tunnel_id: target_tunnel_id.and_then(|s| Uuid::parse_str(&s).ok()),
    })
}

const COLUMNS: &str = "id, name, host, port, username, auth_kind, auth_key_path, local_socks_port, auto_connect, jump_tunnel_id, socks_enabled";

fn row_to_tunnel(row: &rusqlite::Row) -> rusqlite::Result<Tunnel> {
    let id: String = row.get(0)?;
    let auth_kind: String = row.get(5)?;
    let auth_key_path: Option<String> = row.get(6)?;
    let jump_tunnel_id: Option<String> = row.get(9)?;
    Ok(Tunnel {
        id: Uuid::parse_str(&id).unwrap_or_else(|_| Uuid::nil()),
        name: row.get(1)?,
        host: row.get(2)?,
        port: row.get(3)?,
        username: row.get(4)?,
        auth: AuthMethod::from_row(&auth_kind, auth_key_path),
        local_socks_port: row.get(7)?,
        auto_connect: row.get(8)?,
        forwards: Vec::new(),
        jump_tunnel_id: jump_tunnel_id.and_then(|s| Uuid::parse_str(&s).ok()),
        socks_enabled: row.get(10)?,
    })
}

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn);
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn list(&self) -> rusqlite::Result<Vec<Tunnel>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM tunnels ORDER BY name"))?;
        let mut tunnels: Vec<Tunnel> = stmt.query_map([], row_to_tunnel)?.collect::<rusqlite::Result<_>>()?;

        let mut forward_stmt =
            conn.prepare(&format!("SELECT {FORWARD_COLUMNS} FROM port_forwards"))?;
        let forwards: Vec<PortForward> = forward_stmt
            .query_map([], row_to_forward)?
            .collect::<rusqlite::Result<_>>()?;

        for tunnel in &mut tunnels {
            tunnel.forwards = forwards.iter().filter(|f| f.tunnel_id == tunnel.id).cloned().collect();
        }
        Ok(tunnels)
    }

    pub fn get(&self, id: Uuid) -> rusqlite::Result<Option<Tunnel>> {
        let conn = self.conn.lock().unwrap();
        let tunnel = conn
            .query_row(
                &format!("SELECT {COLUMNS} FROM tunnels WHERE id = ?1"),
                params![id.to_string()],
                row_to_tunnel,
            )
            .optional()?;

        let Some(mut tunnel) = tunnel else {
            return Ok(None);
        };
        let mut stmt =
            conn.prepare(&format!("SELECT {FORWARD_COLUMNS} FROM port_forwards WHERE tunnel_id = ?1"))?;
        tunnel.forwards = stmt
            .query_map(params![id.to_string()], row_to_forward)?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Some(tunnel))
    }

    pub fn insert(&self, t: &Tunnel) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO tunnels (id, name, host, port, username, auth_kind, auth_key_path, local_socks_port, auto_connect, jump_tunnel_id, socks_enabled)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                t.id.to_string(),
                t.name,
                t.host,
                t.port,
                t.username,
                t.auth.kind(),
                t.auth.key_path(),
                t.local_socks_port,
                t.auto_connect,
                t.jump_tunnel_id.map(|id| id.to_string()),
                t.socks_enabled,
            ],
        )?;
        Ok(())
    }

    pub fn update(&self, t: &Tunnel) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tunnels SET name=?2, host=?3, port=?4, username=?5, auth_kind=?6, auth_key_path=?7, local_socks_port=?8, auto_connect=?9, jump_tunnel_id=?10, socks_enabled=?11
             WHERE id=?1",
            params![
                t.id.to_string(),
                t.name,
                t.host,
                t.port,
                t.username,
                t.auth.kind(),
                t.auth.key_path(),
                t.local_socks_port,
                t.auto_connect,
                t.jump_tunnel_id.map(|id| id.to_string()),
                t.socks_enabled,
            ],
        )?;
        Ok(())
    }

    pub fn delete(&self, id: Uuid) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM port_forwards WHERE tunnel_id = ?1",
            params![id.to_string()],
        )?;
        conn.execute("DELETE FROM tunnels WHERE id = ?1", params![id.to_string()])?;
        Ok(())
    }

    pub fn insert_forward(&self, f: &PortForward) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO port_forwards (id, tunnel_id, remote_host, remote_port, local_port)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                f.id.to_string(),
                f.tunnel_id.to_string(),
                f.remote_host,
                f.remote_port,
                f.local_port,
            ],
        )?;
        Ok(())
    }

    pub fn update_forward(&self, f: &PortForward) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE port_forwards SET remote_host=?2, remote_port=?3, local_port=?4 WHERE id=?1",
            params![f.id.to_string(), f.remote_host, f.remote_port, f.local_port],
        )?;
        Ok(())
    }

    pub fn delete_forward(&self, id: Uuid) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM port_forwards WHERE id = ?1", params![id.to_string()])?;
        Ok(())
    }

    pub fn get_forward(&self, id: Uuid) -> rusqlite::Result<Option<PortForward>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {FORWARD_COLUMNS} FROM port_forwards WHERE id = ?1"),
            params![id.to_string()],
            row_to_forward,
        )
        .optional()
    }

    pub fn list_router_rules(&self) -> rusqlite::Result<Vec<RouterRule>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {RULE_COLUMNS} FROM router_rules ORDER BY position"
        ))?;
        let rules: Vec<RouterRule> = stmt.query_map([], row_to_rule)?.collect::<rusqlite::Result<_>>()?;
        Ok(rules)
    }

    /// Appends at the end of the evaluation order. `MAX(position)` rather than a
    /// row count so the order survives deletions from the middle of the list.
    pub fn next_rule_position(&self) -> rusqlite::Result<i64> {
        let conn = self.conn.lock().unwrap();
        let max: Option<i64> =
            conn.query_row("SELECT MAX(position) FROM router_rules", [], |row| row.get(0))?;
        Ok(max.map_or(0, |m| m + 1))
    }

    pub fn insert_router_rule(&self, r: &RouterRule) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO router_rules (id, position, enabled, kind, pattern, port, action, target_tunnel_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                r.id.to_string(),
                r.position,
                r.enabled,
                r.kind.as_str(),
                r.pattern,
                r.port,
                r.action.as_str(),
                r.target_tunnel_id.map(|id| id.to_string()),
            ],
        )?;
        Ok(())
    }

    /// Position is deliberately not updated here — reordering goes through
    /// [`Db::reorder_router_rules`] so editing a rule can't shuffle the list.
    pub fn update_router_rule(&self, r: &RouterRule) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE router_rules SET enabled=?2, kind=?3, pattern=?4, port=?5, action=?6, target_tunnel_id=?7
             WHERE id=?1",
            params![
                r.id.to_string(),
                r.enabled,
                r.kind.as_str(),
                r.pattern,
                r.port,
                r.action.as_str(),
                r.target_tunnel_id.map(|id| id.to_string()),
            ],
        )?;
        Ok(())
    }

    pub fn delete_router_rule(&self, id: Uuid) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM router_rules WHERE id = ?1", params![id.to_string()])?;
        Ok(())
    }

    pub fn get_router_rule(&self, id: Uuid) -> rusqlite::Result<Option<RouterRule>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {RULE_COLUMNS} FROM router_rules WHERE id = ?1"),
            params![id.to_string()],
            row_to_rule,
        )
        .optional()
    }

    /// Rewrites the evaluation order from an explicit id list, in one transaction
    /// so a failure part-way can't leave two rules fighting over one position.
    pub fn reorder_router_rules(&self, ids: &[Uuid]) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        for (position, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE router_rules SET position = ?2 WHERE id = ?1",
                params![id.to_string(), position as i64],
            )?;
        }
        tx.commit()
    }

    /// Swaps the whole rule list for a new one, in a transaction. Import
    /// replaces rather than merges: position *is* the meaning of a rule list, so
    /// interleaving two of them produces an order nobody chose.
    pub fn replace_router_rules(&self, rules: &[RouterRule]) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM router_rules", [])?;
        for (position, r) in rules.iter().enumerate() {
            tx.execute(
                "INSERT INTO router_rules (id, position, enabled, kind, pattern, port, action, target_tunnel_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    r.id.to_string(),
                    position as i64,
                    r.enabled,
                    r.kind.as_str(),
                    r.pattern,
                    r.port,
                    r.action.as_str(),
                    r.target_tunnel_id.map(|id| id.to_string()),
                ],
            )?;
        }
        tx.commit()
    }

    /// Swaps a tunnel's forwards for a new set, in a transaction.
    pub fn replace_forwards(
        &self,
        tunnel_id: Uuid,
        forwards: &[PortForward],
    ) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM port_forwards WHERE tunnel_id = ?1",
            params![tunnel_id.to_string()],
        )?;
        for f in forwards {
            tx.execute(
                "INSERT INTO port_forwards (id, tunnel_id, remote_host, remote_port, local_port)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    f.id.to_string(),
                    tunnel_id.to_string(),
                    f.remote_host,
                    f.remote_port,
                    f.local_port,
                ],
            )?;
        }
        tx.commit()
    }

    /// Clears the tunnel target of every rule pointing at a deleted tunnel and
    /// disables them, so a stale rule can't silently fall through to the default
    /// action once its tunnel is gone.
    pub fn orphan_router_rules(&self, tunnel_id: Uuid) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE router_rules SET enabled = 0, target_tunnel_id = NULL WHERE target_tunnel_id = ?1",
            params![tunnel_id.to_string()],
        )?;
        Ok(())
    }
}
