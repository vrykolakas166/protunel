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
        auto_connect INTEGER NOT NULL DEFAULT 0
    );
";

const COLUMNS: &str =
    "id, name, host, port, username, auth_kind, auth_key_path, local_socks_port, auto_connect";

fn row_to_tunnel(row: &rusqlite::Row) -> rusqlite::Result<Tunnel> {
    let id: String = row.get(0)?;
    let auth_kind: String = row.get(5)?;
    let auth_key_path: Option<String> = row.get(6)?;
    Ok(Tunnel {
        id: Uuid::parse_str(&id).unwrap_or_else(|_| Uuid::nil()),
        name: row.get(1)?,
        host: row.get(2)?,
        port: row.get(3)?,
        username: row.get(4)?,
        auth: AuthMethod::from_row(&auth_kind, auth_key_path),
        local_socks_port: row.get(7)?,
        auto_connect: row.get(8)?,
    })
}

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn list(&self) -> rusqlite::Result<Vec<Tunnel>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM tunnels ORDER BY name"))?;
        let rows = stmt.query_map([], row_to_tunnel)?;
        rows.collect()
    }

    pub fn get(&self, id: Uuid) -> rusqlite::Result<Option<Tunnel>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {COLUMNS} FROM tunnels WHERE id = ?1"),
            params![id.to_string()],
            row_to_tunnel,
        )
        .optional()
    }

    pub fn insert(&self, t: &Tunnel) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO tunnels (id, name, host, port, username, auth_kind, auth_key_path, local_socks_port, auto_connect)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
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
            ],
        )?;
        Ok(())
    }

    pub fn update(&self, t: &Tunnel) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tunnels SET name=?2, host=?3, port=?4, username=?5, auth_kind=?6, auth_key_path=?7, local_socks_port=?8, auto_connect=?9
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
            ],
        )?;
        Ok(())
    }

    pub fn delete(&self, id: Uuid) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM tunnels WHERE id = ?1", params![id.to_string()])?;
        Ok(())
    }
}
