use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::db::Db;
use crate::settings::SettingsStore;
use crate::ssh::known_hosts::KnownHosts;
use crate::ssh::PendingHostKeyRequests;

pub struct TunnelHandle {
    pub cancel: CancellationToken,
    pub bytes_up: Arc<AtomicU64>,
    pub bytes_down: Arc<AtomicU64>,
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
