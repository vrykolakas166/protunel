use serde::Serialize;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelStatus {
    Disconnected,
    Connecting,
    Connected,
    /// Was up (or is retrying a failed attempt) and is working its way back —
    /// the tunnel task is still alive, the SSH session is not.
    Reconnecting,
    Error,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    pub tunnel_id: Uuid,
    pub status: TunnelStatus,
    pub message: Option<String>,
}

pub const STATUS_EVENT: &str = "tunnel-status";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyPending {
    pub request_id: Uuid,
    pub tunnel_id: Uuid,
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
    pub algorithm: String,
}

pub const HOST_KEY_PENDING_EVENT: &str = "host-key-pending";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsEvent {
    pub tunnel_id: Uuid,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub uptime_secs: u64,
}

pub const STATS_EVENT: &str = "tunnel-stats";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RouterStatus {
    Stopped,
    Running,
    Error,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterStatusEvent {
    pub status: RouterStatus,
    /// The port actually bound, once running.
    pub port: Option<u16>,
    /// A non-fatal complaint (e.g. the system proxy could not be set) or the
    /// reason the router stopped.
    pub message: Option<String>,
}

pub const ROUTER_STATUS_EVENT: &str = "router-status";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterStatsEvent {
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub active_connections: u64,
}

pub const ROUTER_STATS_EVENT: &str = "router-stats";
