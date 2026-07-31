use serde::Serialize;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelStatus {
    Disconnected,
    Connecting,
    Connected,
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
