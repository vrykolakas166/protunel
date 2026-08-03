use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use uuid::Uuid;

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
}
