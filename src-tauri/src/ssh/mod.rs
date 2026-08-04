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
use crate::tunnel::ForwardCommand;
use crate::AppState;

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
    let _ = app.emit(
        STATUS_EVENT,
        StatusEvent {
            tunnel_id,
            status,
            message: message.clone(),
        },
    );
    crate::tray::rebuild_menu(app);

    let body = match status {
        TunnelStatus::Connected => Some("Connected".to_string()),
        TunnelStatus::Disconnected => Some("Disconnected".to_string()),
        TunnelStatus::Error => Some(message.unwrap_or_else(|| "Connection error".to_string())),
        TunnelStatus::Connecting => None,
    };
    let notifications_enabled = app
        .try_state::<AppState>()
        .map(|s| s.settings.get().notifications_enabled)
        .unwrap_or(true);
    if notifications_enabled {
        if let Some(body) = body {
            let _ = app
                .notification()
                .builder()
                .title(tunnel_name)
                .body(body)
                .show();
        }
    }
}

/// Connects, authenticates, opens the local SOCKS5 listener, and serves connections
/// until `cancel` fires or the session dies. Runs to completion inside its own task.
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

    let result = connect_and_authenticate(&app, &tunnel, secret, known_hosts, pending).await;

    let session = match result {
        Ok(session) => session,
        Err(e) => {
            emit_status(&app, tunnel.id, &tunnel.name, TunnelStatus::Error, Some(e));
            return;
        }
    };

    let listener = if tunnel.socks_enabled {
        match TcpListener::bind(("127.0.0.1", tunnel.local_socks_port)).await {
            Ok(l) => Some(l),
            Err(e) => {
                emit_status(
                    &app,
                    tunnel.id,
                    &tunnel.name,
                    TunnelStatus::Error,
                    Some(format!("failed to bind local SOCKS port {}: {e}", tunnel.local_socks_port)),
                );
                return;
            }
        }
    } else {
        None
    };

    let mut forward_listeners = Vec::with_capacity(tunnel.forwards.len());
    for fwd in &tunnel.forwards {
        match TcpListener::bind(("127.0.0.1", fwd.local_port)).await {
            Ok(l) => forward_listeners.push((l, fwd.clone())),
            Err(e) => {
                emit_status(
                    &app,
                    tunnel.id,
                    &tunnel.name,
                    TunnelStatus::Error,
                    Some(format!("failed to bind local forward port {}: {e}", fwd.local_port)),
                );
                return;
            }
        }
    }

    emit_status(&app, tunnel.id, &tunnel.name, TunnelStatus::Connected, None);

    let session = Arc::new(session);
    *session_slot.lock().unwrap() = Some(session.clone());
    let closed = Arc::new(AtomicBool::new(false));
    let started = Instant::now();
    let mut stats_tick = tokio::time::interval(Duration::from_secs(1));

    let mut forward_tasks: HashMap<Uuid, CancellationToken> = HashMap::new();
    for (fwd_listener, fwd) in forward_listeners {
        let child = cancel.child_token();
        forward_tasks.insert(fwd.id, child.clone());
        spawn_forward_listener(
            fwd_listener,
            fwd,
            session.clone(),
            closed.clone(),
            bytes_up.clone(),
            bytes_down.clone(),
            child,
        );
    }

    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            cmd = forward_rx.recv() => {
                match cmd {
                    Some(ForwardCommand::Add(fwd, resp)) => {
                        match TcpListener::bind(("127.0.0.1", fwd.local_port)).await {
                            Ok(l) => {
                                let child = cancel.child_token();
                                forward_tasks.insert(fwd.id, child.clone());
                                spawn_forward_listener(
                                    l, fwd, session.clone(), closed.clone(), bytes_up.clone(), bytes_down.clone(), child,
                                );
                                let _ = resp.send(Ok(()));
                            }
                            Err(e) => {
                                let _ = resp.send(Err(format!(
                                    "failed to bind local forward port {}: {e}", fwd.local_port
                                )));
                            }
                        }
                    }
                    Some(ForwardCommand::Remove(id, resp)) => {
                        if let Some(token) = forward_tasks.remove(&id) {
                            token.cancel();
                        }
                        let _ = resp.send(Ok(()));
                    }
                    None => break,
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
            accepted = accept_optional(&listener) => {
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
                    Err(e) => {
                        emit_status(&app, tunnel.id, &tunnel.name, TunnelStatus::Error, Some(format!("accept error: {e}")));
                        break;
                    }
                }
            }
        }
    }

    closed.store(true, Ordering::Relaxed);
    *session_slot.lock().unwrap() = None;
    let _ = session
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;
    emit_status(&app, tunnel.id, &tunnel.name, TunnelStatus::Disconnected, None);
}

/// Awaits the SOCKS listener's next connection, or never resolves if SOCKS is
/// disabled for this tunnel — keeps the `select!` arm shape without a busy-loop.
async fn accept_optional(listener: &Option<TcpListener>) -> std::io::Result<(TcpStream, SocketAddr)> {
    match listener {
        Some(l) => l.accept().await,
        None => std::future::pending().await,
    }
}

/// Spawns the accept loop for one local forward listener. Runs until `cancel`
/// fires — either the whole tunnel's token (session torn down) or the forward's
/// own child token (forward removed live while the tunnel keeps running).
fn spawn_forward_listener(
    listener: TcpListener,
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
    let config = Arc::new(client::Config {
        nodelay: true,
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
