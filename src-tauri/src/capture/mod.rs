//! Process capture: launches an arbitrary exe with the hook DLL injected so
//! its outbound TCP traffic lands on the router's SOCKS5 port instead of
//! going direct. This module only owns process lifecycle (launch/track/kill);
//! it deliberately has no rule engine of its own — `router/` already has one,
//! and captured connections are just another way traffic arrives at it.

pub mod inject;
pub mod pid_lookup;

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::router::rules::RuleAction;
use crate::router::RoutingDecision;
use crate::settings::{CaptureConfig, CaptureStore, JsonStore, RecentCapture};

/// Recent-captures MRU list is capped here rather than left unbounded — this
/// is a quick-relaunch convenience, not a history log.
pub const MAX_RECENT_CAPTURES: usize = 5;

/// Same reasoning as the router's own decision log: bounded because this
/// grows once per proxied connection.
const CONNECTION_LOG_CAPACITY: usize = 200;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureConnection {
    pub at: u64,
    pub capture_id: Uuid,
    pub pid: u32,
    pub host: String,
    pub port: u16,
    pub action: RuleAction,
    pub outcome: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedProcess {
    pub id: Uuid,
    pub pid: u32,
    pub exe_path: String,
    pub label: Option<String>,
    pub started_at: u64,
}

impl CapturedProcess {
    pub fn new(pid: u32, exe_path: String, label: Option<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            pid,
            exe_path,
            label,
            started_at: now_secs(),
        }
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub struct CaptureState {
    running: Mutex<HashMap<Uuid, CapturedProcess>>,
    connections: Mutex<VecDeque<CaptureConnection>>,
    store: CaptureStore,
    /// Crash-recovery record — a write-heavy mirror of `running`'s contents,
    /// kept in a *separate* file from `capture.json` specifically so it never
    /// races a saved-target/recent-list edit (same reasoning `settings.rs`
    /// gives for splitting `RouterConfig` out of `Settings`).
    tracking: JsonStore<Vec<CapturedProcess>>,
}

impl CaptureState {
    pub fn new(data_dir: &Path) -> Self {
        let state = Self {
            running: Mutex::new(HashMap::new()),
            connections: Mutex::new(VecDeque::with_capacity(CONNECTION_LOG_CAPACITY)),
            store: CaptureStore::load(data_dir.join("capture.json")),
            tracking: JsonStore::load(data_dir.join("capture_tracking.json")),
        };
        state.reconcile_from_tracking();
        state
    }

    /// Called once at construction (mirrors `router::system_proxy::recover()`'s
    /// placement in `lib.rs`'s `setup()`, before anything else touches
    /// `running`): re-adopts captures still alive from a previous session
    /// that ended without a clean shutdown (crash, kill). A live PID alone
    /// isn't proof — Windows can hand a dead process's PID to something
    /// unrelated — so each candidate's current exe path must still match
    /// what was tracked before it's trusted.
    fn reconcile_from_tracking(&self) {
        let tracked = self.tracking.get();
        if tracked.is_empty() {
            return;
        }
        let mut running = self.running.lock().unwrap();
        for process in tracked {
            let still_same_process = inject::is_running(process.pid)
                && inject::exe_path_of(process.pid)
                    .is_some_and(|p| p.eq_ignore_ascii_case(&process.exe_path));
            if still_same_process {
                running.insert(process.id, process);
            }
        }
        drop(running);
        self.persist_tracking();
    }

    fn persist_tracking(&self) {
        let snapshot: Vec<CapturedProcess> = self.running.lock().unwrap().values().cloned().collect();
        self.tracking.update(snapshot);
    }

    /// Cheap check `router/listener.rs`'s connection hot path gates on, so
    /// ordinary (non-captured) router traffic pays zero extra cost — no PID
    /// lookup, no lock — while no capture is active.
    pub fn has_active(&self) -> bool {
        !self.running.lock().unwrap().is_empty()
    }

    pub fn insert(&self, process: CapturedProcess) {
        self.running.lock().unwrap().insert(process.id, process);
        self.persist_tracking();
    }

    /// Removes and returns the tracked record, regardless of whether the
    /// process is still alive — callers that need liveness use `list`.
    pub fn remove(&self, id: Uuid) -> Option<CapturedProcess> {
        let removed = self.running.lock().unwrap().remove(&id);
        self.persist_tracking();
        removed
    }

    /// Snapshot of tracked captures, dropping any whose process already
    /// exited on its own (crashed, or the user closed it directly) so the
    /// panel doesn't show phantom "running" rows.
    pub fn list(&self) -> Vec<CapturedProcess> {
        let mut running = self.running.lock().unwrap();
        let before = running.len();
        running.retain(|_, p| inject::is_running(p.pid));
        let changed = running.len() != before;
        let snapshot = running.values().cloned().collect();
        drop(running);
        if changed {
            self.persist_tracking();
        }
        snapshot
    }

    pub fn recent(&self) -> Vec<RecentCapture> {
        self.store.get().recent
    }

    /// Moves `exe_path` to the front of the MRU list (updating its args/label
    /// if it was already there) and evicts the oldest entry past
    /// [`MAX_RECENT_CAPTURES`].
    pub fn record_recent(&self, exe_path: String, args: Vec<String>, label: Option<String>) {
        let mut config: CaptureConfig = self.store.get();
        config
            .recent
            .retain(|r| !r.exe_path.eq_ignore_ascii_case(&exe_path));
        config.recent.insert(
            0,
            RecentCapture {
                exe_path,
                args,
                label,
                last_launched_at: now_secs(),
            },
        );
        config.recent.truncate(MAX_RECENT_CAPTURES);
        self.store.update(config);
    }

    /// Attributes a router connection to a captured process, if `pid`
    /// matches one currently tracked as running. No-ops otherwise (e.g. the
    /// PID lookup raced the process exiting) — attribution is best-effort
    /// UI sugar, never load-bearing for routing itself.
    pub fn record_connection(&self, pid: u32, decision: &RoutingDecision) {
        let capture_id = self
            .running
            .lock()
            .unwrap()
            .values()
            .find(|p| p.pid == pid)
            .map(|p| p.id);
        let Some(capture_id) = capture_id else {
            return;
        };

        let entry = CaptureConnection {
            at: decision.at,
            capture_id,
            pid,
            host: decision.host.clone(),
            port: decision.port,
            action: decision.action,
            outcome: decision.outcome.clone(),
        };
        let mut log = self.connections.lock().unwrap();
        if log.len() == CONNECTION_LOG_CAPACITY {
            log.pop_front();
        }
        log.push_back(entry);
    }

    /// Newest first, matching the router's own decision log convention.
    pub fn connections(&self) -> Vec<CaptureConnection> {
        self.connections.lock().unwrap().iter().rev().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real process lifecycle, no hook DLL needed — crash recovery only
    /// cares about PID + exe path bookkeeping, not injection. Ignored by
    /// default (spawns/kills a real notepad.exe), same reasoning as the
    /// injection integration tests in `inject.rs`.
    #[test]
    #[ignore]
    fn reconciles_orphaned_capture_after_restart() {
        let dir = std::env::temp_dir().join(format!("protunel_capture_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let exe_path = "C:\\Windows\\System32\\notepad.exe".to_string();
        let mut child = std::process::Command::new(&exe_path)
            .spawn()
            .expect("spawn notepad");
        let pid = child.id();

        {
            // Simulates a session that launched a capture and then ended
            // without a clean shutdown (crash, kill) — no stop_capture call,
            // just the state getting dropped while the process lives on.
            let state = CaptureState::new(&dir);
            state.insert(CapturedProcess::new(pid, exe_path.clone(), None));
            assert_eq!(state.list().len(), 1);
        }

        // Simulates protunel restarting and reconstructing CaptureState
        // against the same data dir.
        let recovered_state = CaptureState::new(&dir);
        let recovered = recovered_state.list();
        assert_eq!(recovered.len(), 1, "orphaned capture should be re-adopted on restart");
        assert_eq!(recovered[0].pid, pid);
        assert_eq!(recovered[0].exe_path, exe_path);

        let _ = child.kill();
        let _ = child.wait();
        std::thread::sleep(std::time::Duration::from_millis(200));

        // With the process now actually dead, a third restart must not
        // resurrect a phantom entry — this is the PID-reuse guard's other
        // half: `is_running` alone already returns false here, so
        // `exe_path_of`'s match check never even needs to run, but the net
        // behavior (don't re-adopt) is what actually matters.
        let after_exit_state = CaptureState::new(&dir);
        assert_eq!(
            after_exit_state.list().len(),
            0,
            "a truly dead process must not be re-adopted"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
