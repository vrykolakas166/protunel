use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::db::Db;
use crate::ssh::known_hosts::KnownHosts;
use crate::ssh::PendingHostKeyRequests;

pub struct AppState {
    pub db: Db,
    pub known_hosts: Arc<KnownHosts>,
    pub pending_host_key: PendingHostKeyRequests,
    running: Mutex<HashMap<Uuid, CancellationToken>>,
}

impl AppState {
    pub fn new(data_dir: &PathBuf, db: Db) -> Self {
        Self {
            db,
            known_hosts: Arc::new(KnownHosts::load(data_dir.join("known_hosts.json"))),
            pending_host_key: PendingHostKeyRequests::default(),
            running: Mutex::new(HashMap::new()),
        }
    }

    pub fn is_connected(&self, id: Uuid) -> bool {
        self.running.lock().unwrap().contains_key(&id)
    }

    /// Registers a running tunnel's cancellation handle.
    pub fn start(&self, id: Uuid, token: CancellationToken) {
        self.running.lock().unwrap().insert(id, token);
    }

    /// Requests the tunnel's task to stop by cancelling its token.
    pub fn stop(&self, id: Uuid) {
        if let Some(token) = self.running.lock().unwrap().remove(&id) {
            token.cancel();
        }
    }

    /// Called by the tunnel task itself once it has fully wound down.
    pub fn clear(&self, id: Uuid) {
        self.running.lock().unwrap().remove(&id);
    }
}
