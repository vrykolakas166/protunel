pub mod listener;
pub mod pac;
pub mod rules;
pub mod system_proxy;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::db::Db;
use crate::events::{RouterStatus, RouterStatusEvent, ROUTER_STATUS_EVENT};
use crate::settings::{RouterConfig, RouterStore};
use rules::{CompiledRule, MatchOutcome, RuleAction};

/// How many recent routing decisions the panel can show. Bounded because this
/// grows once per proxied connection and a busy browser makes hundreds.
const DECISION_LOG_CAPACITY: usize = 200;

/// One routing decision, kept so the user can answer "why did that request go
/// direct?" without attaching a debugger. This is the main debugging affordance
/// for a rule list that silently does the wrong thing.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingDecision {
    pub at: u64,
    pub host: String,
    pub port: u16,
    /// `None` means no rule matched and the default action applied.
    pub rule_id: Option<Uuid>,
    pub action: RuleAction,
    pub target_tunnel_id: Option<Uuid>,
    /// `"ok"`, or why the connection could not be served.
    pub outcome: String,
}

struct RunningRouter {
    cancel: CancellationToken,
    port: u16,
    /// Set only when the system proxy is being driven via a PAC script.
    pac_url: Option<String>,
}

pub struct RouterState {
    pub store: RouterStore,
    /// Compiled snapshot of the rule list. Swapped wholesale on every mutation so
    /// the per-connection hot path never recompiles a regex, and never holds a
    /// lock across an await (callers clone the `Arc` out first).
    compiled: RwLock<Arc<Vec<CompiledRule>>>,
    /// Patterns that failed to compile on the last reload, surfaced in the UI.
    compile_errors: RwLock<Vec<String>>,
    decisions: Mutex<VecDeque<RoutingDecision>>,
    running: Mutex<Option<RunningRouter>>,
    /// Serializes on-demand tunnel dials. Several concurrent requests for the
    /// same not-yet-connected tunnel must produce one connect, not one each.
    pub connect_lock: tokio::sync::Mutex<()>,
    pub bytes_up: Arc<AtomicU64>,
    pub bytes_down: Arc<AtomicU64>,
    pub active_connections: Arc<AtomicU64>,
}

impl RouterState {
    pub fn new(data_dir: &PathBuf) -> Self {
        Self {
            store: RouterStore::load(data_dir.join("router.json")),
            compiled: RwLock::new(Arc::new(Vec::new())),
            compile_errors: RwLock::new(Vec::new()),
            decisions: Mutex::new(VecDeque::with_capacity(DECISION_LOG_CAPACITY)),
            running: Mutex::new(None),
            connect_lock: tokio::sync::Mutex::new(()),
            bytes_up: Arc::new(AtomicU64::new(0)),
            bytes_down: Arc::new(AtomicU64::new(0)),
            active_connections: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn config(&self) -> RouterConfig {
        self.store.get()
    }

    /// Re-reads the rule list and recompiles it. Rules whose pattern no longer
    /// compiles are dropped from the active set and reported, rather than taking
    /// the whole router down.
    pub fn reload_rules(&self, db: &Db) -> Result<Vec<String>, String> {
        let rules = db.list_router_rules().map_err(|e| e.to_string())?;
        let (compiled, errors) = rules::compile_all(rules);
        *self.compiled.write().unwrap() = Arc::new(compiled);
        *self.compile_errors.write().unwrap() = errors.clone();
        Ok(errors)
    }

    pub fn rules(&self) -> Arc<Vec<CompiledRule>> {
        self.compiled.read().unwrap().clone()
    }

    pub fn compile_errors(&self) -> Vec<String> {
        self.compile_errors.read().unwrap().clone()
    }

    /// Runs the matcher without opening any connection — backs the panel's
    /// "test a hostname" box.
    pub async fn evaluate(&self, target: &rules::Target) -> MatchOutcome {
        let config = self.config();
        let rules = self.rules();
        rules::match_target(
            &rules,
            target,
            config.default_action,
            config.default_tunnel_id,
            config.resolve_for_ip_rules,
        )
        .await
    }

    pub fn record_decision(&self, decision: RoutingDecision) {
        let mut log = self.decisions.lock().unwrap();
        if log.len() == DECISION_LOG_CAPACITY {
            log.pop_front();
        }
        log.push_back(decision);
    }

    /// Newest first, which is the order the panel wants.
    pub fn decisions(&self) -> Vec<RoutingDecision> {
        self.decisions.lock().unwrap().iter().rev().cloned().collect()
    }

    pub fn running_port(&self) -> Option<u16> {
        self.running.lock().unwrap().as_ref().map(|r| r.port)
    }

    pub fn pac_url(&self) -> Option<String> {
        self.running.lock().unwrap().as_ref().and_then(|r| r.pac_url.clone())
    }

    fn take_running(&self) -> Option<RunningRouter> {
        self.running.lock().unwrap().take()
    }

    fn set_running(&self, running: RunningRouter) {
        *self.running.lock().unwrap() = Some(running);
    }
}

pub fn emit_status(app: &AppHandle, status: RouterStatus, port: Option<u16>, message: Option<String>) {
    let _ = app.emit(
        ROUTER_STATUS_EVENT,
        RouterStatusEvent {
            status,
            port,
            message,
        },
    );
}

/// Binds the router port and starts serving. Idempotent-ish: an already-running
/// router is stopped first so a port or rule change can restart cleanly.
pub async fn start(app: &AppHandle) -> Result<(), String> {
    stop(app).await;

    let state = app.state::<crate::AppState>();
    let config = state.router.config();
    state.router.reload_rules(&state.db)?;

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", config.port))
        .await
        .map_err(|e| format!("failed to bind router port {}: {e}", config.port))?;

    let cancel = CancellationToken::new();
    state.router.bytes_up.store(0, Ordering::Relaxed);
    state.router.bytes_down.store(0, Ordering::Relaxed);

    // Windows' fixed-proxy `socks=` setting means SOCKS4, which this SOCKS5
    // listener has to refuse, so system-wide wiring goes through a PAC script
    // that can name SOCKS5 explicitly.
    let mut pac_url = None;
    if config.set_system_proxy {
        let script = pac::build_script(config.port, &config.bypass_list);
        let result = pac::spawn(script, cancel.clone())
            .await
            .and_then(|pac_port| {
                let url = format!("http://127.0.0.1:{pac_port}/protunel.pac");
                system_proxy::enable(app, &url).map(|()| url)
            });
        match result {
            Ok(url) => pac_url = Some(url),
            // The router is serving either way; the user just has to point apps
            // at it by hand. Worth saying out loud rather than failing the start.
            Err(e) => {
                // Also to stderr: the status event is transient and only lands
                // if a window happens to be listening, which makes a failure
                // here invisible in exactly the case you need to debug it.
                eprintln!("[router] system proxy not configured: {e}");
                emit_status(app, RouterStatus::Running, Some(config.port), Some(e));
            }
        }
    }

    state.router.set_running(RunningRouter {
        cancel: cancel.clone(),
        port: config.port,
        pac_url,
    });

    listener::spawn(app.clone(), listener, cancel);
    emit_status(app, RouterStatus::Running, Some(config.port), None);
    Ok(())
}

/// Stops the listener and undoes the system proxy. Safe to call when not running.
pub async fn stop(app: &AppHandle) {
    let Some(state) = app.try_state::<crate::AppState>() else {
        return;
    };
    let was_running = state.router.take_running();
    if let Some(running) = was_running {
        running.cancel.cancel();
    }
    // Restore unconditionally: if a previous run crashed before restoring, this
    // is the path that cleans it up.
    let _ = system_proxy::disable(app);
    emit_status(app, RouterStatus::Stopped, None, None);
}

/// Applies a rule or config change to a live router. A port change needs a
/// rebind, everything else can be swapped in place.
pub async fn apply_change(app: &AppHandle, needs_restart: bool) -> Result<(), String> {
    let state = app.state::<crate::AppState>();
    let config = state.router.config();

    if !config.enabled {
        stop(app).await;
        return Ok(());
    }
    if needs_restart || state.router.running_port() != Some(config.port) {
        return start(app).await;
    }
    state.router.reload_rules(&state.db)?;
    Ok(())
}
