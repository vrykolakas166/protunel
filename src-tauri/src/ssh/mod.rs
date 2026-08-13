mod counting_stream;
pub mod forward;
pub mod known_hosts;
pub mod socks;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client::{self, AuthResult};
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKey};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::db::{AuthMethod, PortForward, Tunnel};
use crate::events::{
    HostKeyPending, StatsEvent, StatusEvent, TunnelStatus, HOST_KEY_PENDING_EVENT, STATS_EVENT,
    STATUS_EVENT,
};
use crate::settings::Settings;
use crate::tunnel::ForwardCommand;
use crate::AppState;

/// How often the supervisor asks the SSH session whether it is still alive. The
/// session itself dies from keepalive timeouts; this is just how fast we notice.
const HEALTH_CHECK_INTERVAL: Duration = Duration::from_secs(5);

/// Registry of host-key confirmation prompts currently waiting on the frontend.
#[derive(Default, Clone)]
pub struct PendingHostKeyRequests(Arc<Mutex<HashMap<Uuid, oneshot::Sender<bool>>>>);

impl PendingHostKeyRequests {
    pub fn insert(&self, id: Uuid, tx: oneshot::Sender<bool>) {
        self.0.lock().unwrap().insert(id, tx);
    }

    pub fn resolve(&self, id: Uuid, accepted: bool) -> bool {
        if let Some(tx) = self.0.lock().unwrap().remove(&id) {
            let _ = tx.send(accepted);
            true
        } else {
            false
        }
    }
}

pub struct SshHandler {
    app: AppHandle,
    tunnel_id: Uuid,
    host: String,
    port: u16,
    known_hosts: Arc<known_hosts::KnownHosts>,
    pending: PendingHostKeyRequests,
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_public_key: &PublicKey) -> Result<bool, Self::Error> {
        let key_id = format!("{}:{}", self.host, self.port);
        let openssh_key = server_public_key.to_openssh().unwrap_or_default();

        if let Some(matches) = self.known_hosts.check(&key_id, &openssh_key) {
            return Ok(matches);
        }

        // Unknown host key: block on an explicit user decision instead of the old
        // app's silent auto-trust. Frontend renders a confirm modal off this event.
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let algorithm = server_public_key.algorithm().to_string();
        let request_id = Uuid::new_v4();
        let (tx, rx) = oneshot::channel();
        self.pending.insert(request_id, tx);

        let _ = self.app.emit(
            HOST_KEY_PENDING_EVENT,
            HostKeyPending {
                request_id,
                tunnel_id: self.tunnel_id,
                host: self.host.clone(),
                port: self.port,
                fingerprint: fingerprint.clone(),
                algorithm: algorithm.clone(),
            },
        );

        let accepted = tokio::time::timeout(Duration::from_secs(120), rx)
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or(false);

        if accepted {
            self.known_hosts.trust(&key_id, &openssh_key, &fingerprint, &algorithm);
        }

        Ok(accepted)
    }
}

fn emit_status(
    app: &AppHandle,
    tunnel_id: Uuid,
    tunnel_name: &str,
    status: TunnelStatus,
    message: Option<String>,
) {
    let event = StatusEvent {
        tunnel_id,
        status,
        message: message.clone(),
    };
    if let Some(state) = app.try_state::<AppState>() {
        state.set_status(event.clone());
    }
    let _ = app.emit(STATUS_EVENT, event);
    crate::tray::rebuild_menu(app);

    let body = match status {
        TunnelStatus::Connected => Some("Connected".to_string()),
        TunnelStatus::Disconnected => Some("Disconnected".to_string()),
        TunnelStatus::Error => Some(message.unwrap_or_else(|| "Connection error".to_string())),
        // Retries are noisy by nature — the UI shows them, the tray doesn't need
        // to pop a toast for every backoff tick.
        TunnelStatus::Connecting | TunnelStatus::Reconnecting => None,
    };
    if let Some(body) = body {
        notify(app, tunnel_name, &body);
    }
}

/// Desktop toast for something the user should know about without the window open.
fn notify(app: &AppHandle, title: &str, body: &str) {
    if !settings(app).notifications_enabled {
        return;
    }
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Why a live SSH session stopped, which is what decides whether the supervisor
/// reconnects or lets the tunnel task end.
enum SessionEnd {
    /// The user (or app shutdown) asked this tunnel to stop.
    Cancelled,
    /// The session died underneath us — dead VPN, TCP reset, keepalive timeout,
    /// jump parent going away. Worth retrying.
    Lost(String),
}

/// Local listeners for one tunnel. Bound once for the tunnel's whole lifetime,
/// *not* per SSH session: rebinding on every reconnect would hand the ports to
/// whatever else grabbed them during the outage.
struct Listeners {
    socks: Option<Arc<TcpListener>>,
    forwards: HashMap<Uuid, (Arc<TcpListener>, PortForward)>,
}

fn settings(app: &AppHandle) -> Settings {
    app.try_state::<AppState>()
        .map(|s| s.settings.get())
        .unwrap_or_default()
}

/// 2s, 4s, 8s, 16s, then a flat 30s — a blip barely registers, an overnight
/// outage isn't hammered.
fn backoff(attempt: u32) -> Duration {
    Duration::from_secs(2u64.saturating_pow(attempt.clamp(1, 5)).min(30))
}

/// Failures that retrying cannot fix: wrong credentials, a host key the user
/// rejected, a self-referential jump. Everything else (DNS, TCP, a jump parent
/// that is itself mid-reconnect) gets another go.
fn is_fatal(error: &str) -> bool {
    const FATAL: [&str; 8] = [
        "authentication failed",
        "no password stored",
        "failed to load private key",
        "ssh-agent",
        "Unknown server key",
        "Wrong server signature",
        "tunnel cannot jump through itself",
        "No common key exchange algorithm",
    ];
    FATAL.iter().any(|f| error.contains(f))
}

/// Decides whether a failure that just happened earns attempt number `attempt`.
fn should_retry(app: &AppHandle, error: &str, attempt: u32) -> bool {
    if is_fatal(error) {
        return false;
    }
    let settings = settings(app);
    if !settings.auto_reconnect_enabled {
        return false;
    }
    settings.reconnect_max_attempts == 0 || attempt <= settings.reconnect_max_attempts
}

/// Owns one tunnel for its whole lifetime: binds its local listeners, then keeps
/// an authenticated SSH session behind them, reconnecting with backoff whenever
/// that session dies. Returns only on user cancellation or an unrecoverable
/// error. Runs to completion inside its own task.
pub async fn run_tunnel(
    app: AppHandle,
    tunnel: Tunnel,
    secret: Option<String>,
    known_hosts: Arc<known_hosts::KnownHosts>,
    pending: PendingHostKeyRequests,
    cancel: CancellationToken,
    bytes_up: Arc<AtomicU64>,
    bytes_down: Arc<AtomicU64>,
    mut forward_rx: mpsc::UnboundedReceiver<ForwardCommand>,
    session_slot: Arc<Mutex<Option<Arc<client::Handle<SshHandler>>>>>,
) {
    emit_status(&app, tunnel.id, &tunnel.name, TunnelStatus::Connecting, None);

    let mut listeners = match bind_listeners(&tunnel).await {
        Ok(l) => l,
        Err(e) => {
            emit_status(&app, tunnel.id, &tunnel.name, TunnelStatus::Error, Some(e));
            return;
        }
    };

    let mut attempt: u32 = 0;
    let mut last_error: Option<String> = None;

    loop {
        if attempt > 0 {
            emit_status(
                &app,
                tunnel.id,
                &tunnel.name,
                TunnelStatus::Reconnecting,
                Some(format!(
                    "attempt {attempt}: {}",
                    last_error.as_deref().unwrap_or("connection lost")
                )),
            );
        }

        // Connecting can block for a long time (TCP timeouts, a host-key prompt
        // waiting on the user). Without this the tunnel could report Connected
        // after the user already asked it to stop.
        let connecting = connect_and_authenticate(
            &app,
            &tunnel,
            secret.clone(),
            known_hosts.clone(),
            pending.clone(),
        );
        let result = tokio::select! {
            _ = cancel.cancelled() => {
                emit_status(&app, tunnel.id, &tunnel.name, TunnelStatus::Disconnected, None);
                return;
            }
            result = connecting => result,
        };

        let session = match result {
            Ok(session) => session,
            Err(e) => {
                attempt += 1;
                if !should_retry(&app, &e, attempt) {
                    emit_status(&app, tunnel.id, &tunnel.name, TunnelStatus::Error, Some(e));
                    return;
                }
                last_error = Some(e);
                if !wait_before_retry(&cancel, &mut forward_rx, &mut listeners, backoff(attempt)).await
                {
                    emit_status(&app, tunnel.id, &tunnel.name, TunnelStatus::Disconnected, None);
                    return;
                }
                continue;
            }
        };

        let session = Arc::new(session);
        *session_slot.lock().unwrap() = Some(session.clone());
        emit_status(&app, tunnel.id, &tunnel.name, TunnelStatus::Connected, None);

        let session_started = Instant::now();
        let end = run_session(
            &app,
            &tunnel,
            &session,
            &cancel,
            &mut forward_rx,
            &mut listeners,
            &bytes_up,
            &bytes_down,
        )
        .await;

        *session_slot.lock().unwrap() = None;
        let _ = session
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;

        match end {
            SessionEnd::Cancelled => {
                emit_status(&app, tunnel.id, &tunnel.name, TunnelStatus::Disconnected, None);
                return;
            }
            SessionEnd::Lost(reason) => {
                // A session that stayed up for a while counts as a fresh start,
                // so a single drop reconnects in seconds. One that dies right
                // after connecting keeps escalating, so a flapping server or a
                // half-up VPN isn't hammered.
                attempt = if session_started.elapsed() >= Duration::from_secs(60) {
                    1
                } else {
                    attempt + 1
                };
                if !should_retry(&app, &reason, attempt) {
                    emit_status(
                        &app,
                        tunnel.id,
                        &tunnel.name,
                        TunnelStatus::Error,
                        Some(reason),
                    );
                    return;
                }
                // Toast the drop itself once, not every backoff tick — losing a
                // tunnel silently is exactly the thing worth knowing about.
                if attempt == 1 {
                    notify(&app, &tunnel.name, &format!("Connection lost ({reason}) — reconnecting…"));
                }
                last_error = Some(reason);
                if !wait_before_retry(&cancel, &mut forward_rx, &mut listeners, backoff(attempt)).await
                {
                    emit_status(&app, tunnel.id, &tunnel.name, TunnelStatus::Disconnected, None);
                    return;
                }
            }
        }
    }
}

/// Binds the tunnel's SOCKS port and every configured forward port up front, so
/// the ports are reserved for as long as the tunnel exists — including while it
/// is between connection attempts.
async fn bind_listeners(tunnel: &Tunnel) -> Result<Listeners, String> {
    let socks = if tunnel.socks_enabled {
        let listener = TcpListener::bind(("127.0.0.1", tunnel.local_socks_port))
            .await
            .map_err(|e| {
                format!("failed to bind local SOCKS port {}: {e}", tunnel.local_socks_port)
            })?;
        Some(Arc::new(listener))
    } else {
        None
    };

    let mut forwards = HashMap::with_capacity(tunnel.forwards.len());
    for fwd in &tunnel.forwards {
        let listener = TcpListener::bind(("127.0.0.1", fwd.local_port))
            .await
            .map_err(|e| format!("failed to bind local forward port {}: {e}", fwd.local_port))?;
        forwards.insert(fwd.id, (Arc::new(listener), fwd.clone()));
    }

    Ok(Listeners { socks, forwards })
}

/// Serves traffic over one authenticated session until it is cancelled or the
/// session goes away.
async fn run_session(
    app: &AppHandle,
    tunnel: &Tunnel,
    session: &Arc<client::Handle<SshHandler>>,
    cancel: &CancellationToken,
    forward_rx: &mut mpsc::UnboundedReceiver<ForwardCommand>,
    listeners: &mut Listeners,
    bytes_up: &Arc<AtomicU64>,
    bytes_down: &Arc<AtomicU64>,
) -> SessionEnd {
    // Scoped to this session only: cancelled on every teardown so the accept
    // loops don't outlive the session handle they forward onto.
    let session_token = cancel.child_token();
    let closed = Arc::new(AtomicBool::new(false));
    let started = Instant::now();
    let mut stats_tick = tokio::time::interval(Duration::from_secs(1));
    let mut health_tick = tokio::time::interval(HEALTH_CHECK_INTERVAL);

    let mut forward_tasks: HashMap<Uuid, CancellationToken> = HashMap::new();
    for (listener, fwd) in listeners.forwards.values() {
        let child = session_token.child_token();
        forward_tasks.insert(fwd.id, child.clone());
        spawn_forward_listener(
            listener.clone(),
            fwd.clone(),
            session.clone(),
            closed.clone(),
            bytes_up.clone(),
            bytes_down.clone(),
            child,
        );
    }

    let end = loop {
        tokio::select! {
            _ = cancel.cancelled() => break SessionEnd::Cancelled,
            _ = health_tick.tick() => {
                // russh tears the session down once keepalives go unanswered, so a
                // closed handle is how a dead VPN or a rebooted server shows up.
                if session.is_closed() {
                    break SessionEnd::Lost("connection lost".to_string());
                }
            }
            cmd = forward_rx.recv() => {
                match cmd {
                    Some(ForwardCommand::Add(fwd, resp)) => {
                        match bind_forward(listeners, fwd.clone()).await {
                            Ok(listener) => {
                                let child = session_token.child_token();
                                forward_tasks.insert(fwd.id, child.clone());
                                spawn_forward_listener(
                                    listener, fwd, session.clone(), closed.clone(),
                                    bytes_up.clone(), bytes_down.clone(), child,
                                );
                                let _ = resp.send(Ok(()));
                            }
                            Err(e) => {
                                let _ = resp.send(Err(e));
                            }
                        }
                    }
                    Some(ForwardCommand::Remove(id, resp)) => {
                        if let Some(token) = forward_tasks.remove(&id) {
                            token.cancel();
                        }
                        listeners.forwards.remove(&id);
                        let _ = resp.send(Ok(()));
                    }
                    None => break SessionEnd::Cancelled,
                }
            }
            _ = stats_tick.tick() => {
                let _ = app.emit(
                    STATS_EVENT,
                    StatsEvent {
                        tunnel_id: tunnel.id,
                        bytes_up: bytes_up.load(Ordering::Relaxed),
                        bytes_down: bytes_down.load(Ordering::Relaxed),
                        uptime_secs: started.elapsed().as_secs(),
                    },
                );
            }
            accepted = accept_optional(&listeners.socks) => {
                match accepted {
                    Ok((stream, _addr)) => {
                        let session = session.clone();
                        let closed = closed.clone();
                        let bytes_up = bytes_up.clone();
                        let bytes_down = bytes_down.clone();
                        let local_socks_port = tunnel.local_socks_port;
                        tokio::spawn(async move {
                            if let Err(e) = socks::serve_connection(stream, &session, bytes_up, bytes_down).await {
                                if !closed.load(Ordering::Relaxed) {
                                    eprintln!("[socks :{local_socks_port}] connection error: {e}");
                                }
                            }
                        });
                    }
                    // The listener itself failing is not something a reconnect
                    // fixes, but it also can't be served — treat it as lost and
                    // let the supervisor's classifier decide.
                    Err(e) => break SessionEnd::Lost(format!("accept error: {e}")),
                }
            }
        }
    };

    closed.store(true, Ordering::Relaxed);
    session_token.cancel();
    end
}

/// Sleeps out the backoff while still answering forward add/remove commands, so
/// editing a tunnel's forwards doesn't hang the UI for the length of a retry
/// delay. Returns `false` if the tunnel was cancelled while waiting.
async fn wait_before_retry(
    cancel: &CancellationToken,
    forward_rx: &mut mpsc::UnboundedReceiver<ForwardCommand>,
    listeners: &mut Listeners,
    delay: Duration,
) -> bool {
    let sleep = tokio::time::sleep(delay);
    tokio::pin!(sleep);

    loop {
        tokio::select! {
            _ = cancel.cancelled() => return false,
            _ = &mut sleep => return true,
            cmd = forward_rx.recv() => {
                match cmd {
                    Some(ForwardCommand::Add(fwd, resp)) => {
                        let _ = resp.send(bind_forward(listeners, fwd).await.map(|_| ()));
                    }
                    Some(ForwardCommand::Remove(id, resp)) => {
                        listeners.forwards.remove(&id);
                        let _ = resp.send(Ok(()));
                    }
                    None => return false,
                }
            }
        }
    }
}

/// Binds one forward's local port and records it, so it survives into the next
/// session. Re-adding an id that is already bound reuses the existing listener.
async fn bind_forward(
    listeners: &mut Listeners,
    fwd: PortForward,
) -> Result<Arc<TcpListener>, String> {
    if let Some((listener, _)) = listeners.forwards.get(&fwd.id) {
        return Ok(listener.clone());
    }
    let listener = TcpListener::bind(("127.0.0.1", fwd.local_port))
        .await
        .map_err(|e| format!("failed to bind local forward port {}: {e}", fwd.local_port))?;
    let listener = Arc::new(listener);
    listeners.forwards.insert(fwd.id, (listener.clone(), fwd));
    Ok(listener)
}

/// Awaits the SOCKS listener's next connection, or never resolves if SOCKS is
/// disabled for this tunnel — keeps the `select!` arm shape without a busy-loop.
async fn accept_optional(
    listener: &Option<Arc<TcpListener>>,
) -> std::io::Result<(TcpStream, SocketAddr)> {
    match listener {
        Some(l) => l.accept().await,
        None => std::future::pending().await,
    }
}

/// Spawns the accept loop for one local forward listener. Runs until `cancel`
/// fires — the session's token (session torn down or reconnecting) or the
/// forward's own child token (forward removed live while the tunnel keeps running).
fn spawn_forward_listener(
    listener: Arc<TcpListener>,
    fwd: PortForward,
    session: Arc<client::Handle<SshHandler>>,
    closed: Arc<AtomicBool>,
    bytes_up: Arc<AtomicU64>,
    bytes_down: Arc<AtomicU64>,
    cancel: CancellationToken,
) {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, _addr)) => {
                            let session = session.clone();
                            let closed = closed.clone();
                            let bytes_up = bytes_up.clone();
                            let bytes_down = bytes_down.clone();
                            let remote_host = fwd.remote_host.clone();
                            let remote_port = fwd.remote_port;
                            let local_port = fwd.local_port;
                            tokio::spawn(async move {
                                if let Err(e) = forward::serve_forward_connection(
                                    stream, &session, &remote_host, remote_port, bytes_up, bytes_down,
                                ).await {
                                    if !closed.load(Ordering::Relaxed) {
                                        eprintln!(
                                            "[forward :{local_port} -> {remote_host}:{remote_port}] connection error: {e}"
                                        );
                                    }
                                }
                            });
                        }
                        Err(_) => break,
                    }
                }
            }
        }
    });
}

async fn connect_and_authenticate(
    app: &AppHandle,
    tunnel: &Tunnel,
    secret: Option<String>,
    known_hosts: Arc<known_hosts::KnownHosts>,
    pending: PendingHostKeyRequests,
) -> Result<client::Handle<SshHandler>, String> {
    // Without keepalives a session that lost its underlying network never
    // notices — it just sits there looking connected. russh sends these on an
    // idle link and kills the session after `keepalive_max` go unanswered.
    let keepalive_secs = settings(app).keepalive_interval_secs;
    let config = Arc::new(client::Config {
        nodelay: true,
        keepalive_interval: (keepalive_secs > 0)
            .then(|| Duration::from_secs(keepalive_secs.max(5) as u64)),
        keepalive_max: 3,
        ..Default::default()
    });

    let handler = SshHandler {
        app: app.clone(),
        tunnel_id: tunnel.id,
        host: tunnel.host.clone(),
        port: tunnel.port,
        known_hosts,
        pending,
    };

    let mut session = if let Some(jump_id) = tunnel.jump_tunnel_id {
        if jump_id == tunnel.id {
            return Err("tunnel cannot jump through itself".to_string());
        }
        let jump_session = app
            .state::<AppState>()
            .session_for(jump_id)
            .ok_or_else(|| "jump tunnel is not connected".to_string())?;
        let channel = jump_session
            .channel_open_direct_tcpip(tunnel.host.clone(), tunnel.port as u32, "127.0.0.1", 0)
            .await
            .map_err(|e| format!("failed to open jump channel: {e}"))?;
        client::connect_stream(config, channel.into_stream(), handler)
            .await
            .map_err(|e| format!("connect over jump failed: {e}"))?
    } else {
        let addr: (&str, u16) = (&tunnel.host, tunnel.port);
        client::connect(config, addr, handler)
            .await
            .map_err(|e| format!("connect failed: {e}"))?
    };

    let auth = authenticate(&mut session, tunnel, secret).await?;
    if !auth.success() {
        return Err("authentication failed".to_string());
    }

    Ok(session)
}

async fn authenticate(
    session: &mut client::Handle<SshHandler>,
    tunnel: &Tunnel,
    secret: Option<String>,
) -> Result<AuthResult, String> {
    match &tunnel.auth {
        AuthMethod::Password => {
            let password = secret.ok_or("no password stored for this tunnel")?;
            session
                .authenticate_password(tunnel.username.clone(), password)
                .await
                .map_err(|e| format!("password authentication failed: {e}"))
        }
        AuthMethod::PrivateKey { path } => {
            let key = load_secret_key(path, secret.as_deref())
                .map_err(|e| format!("failed to load private key: {e}"))?;
            let hash_alg = session
                .best_supported_rsa_hash()
                .await
                .map_err(|e| format!("failed to negotiate key algorithm: {e}"))?
                .flatten();
            session
                .authenticate_publickey(
                    tunnel.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await
                .map_err(|e| format!("public key authentication failed: {e}"))
        }
        AuthMethod::Agent => authenticate_via_agent(session, tunnel).await,
    }
}

async fn authenticate_via_agent(
    session: &mut client::Handle<SshHandler>,
    tunnel: &Tunnel,
) -> Result<AuthResult, String> {
    let mut agent = AgentClient::connect_pageant()
        .await
        .map_err(|e| format!("failed to connect to ssh-agent (Pageant): {e}"))?;

    let identities = agent
        .request_identities()
        .await
        .map_err(|e| format!("failed to list ssh-agent identities: {e}"))?;

    if identities.is_empty() {
        return Err("ssh-agent has no loaded identities".to_string());
    }

    let hash_alg = session
        .best_supported_rsa_hash()
        .await
        .map_err(|e| format!("failed to negotiate key algorithm: {e}"))?
        .flatten();

    for identity in identities {
        let AgentIdentity::PublicKey { key, .. } = identity else {
            continue;
        };
        match session
            .authenticate_publickey_with(tunnel.username.clone(), key, hash_alg, &mut agent)
            .await
        {
            Ok(result) if result.success() => return Ok(result),
            _ => continue,
        }
    }

    Err("ssh-agent did not have a key accepted by the server".to_string())
}
