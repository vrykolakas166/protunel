use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

use russh::client;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::db::Db;
use crate::db::PortForward;
use crate::settings::SettingsStore;
use crate::ssh::known_hosts::KnownHosts;
use crate::ssh::PendingHostKeyRequests;
use crate::ssh::SshHandler;

/// Live control message for a running tunnel's port forwards, so forwards can be
/// added/removed without tearing down the SSH session (and its SOCKS listener).
pub enum ForwardCommand {
    Add(PortForward, oneshot::Sender<Result<(), String>>),
    Remove(Uuid, oneshot::Sender<Result<(), String>>),
}

pub struct TunnelHandle {
    pub cancel: CancellationToken,
    pub bytes_up: Arc<AtomicU64>,
    pub bytes_down: Arc<AtomicU64>,
    pub forward_tx: mpsc::UnboundedSender<ForwardCommand>,
    /// Populated once the SSH session is actually authenticated, so other tunnels
    /// can jump through this one via a `direct-tcpip` channel on its session.
    pub session: Arc<Mutex<Option<Arc<client::Handle<SshHandler>>>>>,
}

pub struct AppState {
    pub db: Db,
    pub known_hosts: Arc<KnownHosts>,
    pub pending_host_key: PendingHostKeyRequests,
    pub settings: SettingsStore,
    running: Mutex<HashMap<Uuid, TunnelHandle>>,
}

impl AppState {
    pub fn new(data_dir: &PathBuf, db: Db) -> Self {
        Self {
            db,
            known_hosts: Arc::new(KnownHosts::load(data_dir.join("known_hosts.json"))),
            pending_host_key: PendingHostKeyRequests::default(),
            settings: SettingsStore::load(data_dir.join("settings.json")),
            running: Mutex::new(HashMap::new()),
        }
    }

    pub fn is_connected(&self, id: Uuid) -> bool {
        self.running.lock().unwrap().contains_key(&id)
    }

    /// Returns a sender for hot-applying forward changes to an already-running
    /// tunnel's task, or `None` if the tunnel isn't currently connected.
    pub fn forward_sender(&self, id: Uuid) -> Option<mpsc::UnboundedSender<ForwardCommand>> {
        self.running.lock().unwrap().get(&id).map(|h| h.forward_tx.clone())
    }

    /// Returns the live SSH session for a running tunnel, so another tunnel can
    /// jump through it. `None` if the tunnel isn't running or hasn't finished
    /// authenticating yet.
    pub fn session_for(&self, id: Uuid) -> Option<Arc<client::Handle<SshHandler>>> {
        self.running
            .lock()
            .unwrap()
            .get(&id)
            .and_then(|h| h.session.lock().unwrap().clone())
    }

    /// Registers a running tunnel's cancellation handle and byte counters.
    pub fn start(&self, id: Uuid, handle: TunnelHandle) {
        self.running.lock().unwrap().insert(id, handle);
    }

    /// Requests the tunnel's task to stop by cancelling its token.
    pub fn stop(&self, id: Uuid) {
        if let Some(handle) = self.running.lock().unwrap().remove(&id) {
            handle.cancel.cancel();
        }
    }

    /// Called by the tunnel task itself once it has fully wound down.
    pub fn clear(&self, id: Uuid) {
        self.running.lock().unwrap().remove(&id);
    }
}
