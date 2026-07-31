mod counting_stream;
pub mod known_hosts;
pub mod socks;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client::{self, AuthResult};
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKey};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::db::{AuthMethod, Tunnel};
use crate::events::{
    HostKeyPending, StatsEvent, StatusEvent, TunnelStatus, HOST_KEY_PENDING_EVENT, STATS_EVENT,
    STATUS_EVENT,
};

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

pub(crate) struct SshHandler {
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
    if let Some(body) = body {
        let _ = app
            .notification()
            .builder()
            .title(tunnel_name)
            .body(body)
            .show();
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

    let listener = match TcpListener::bind(("127.0.0.1", tunnel.local_socks_port)).await {
        Ok(l) => l,
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
    };

    emit_status(&app, tunnel.id, &tunnel.name, TunnelStatus::Connected, None);

    let session = Arc::new(session);
    let closed = Arc::new(AtomicBool::new(false));
    let started = Instant::now();
    let mut stats_tick = tokio::time::interval(Duration::from_secs(1));

    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
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
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _addr)) => {
                        let session = session.clone();
                        let closed = closed.clone();
                        let bytes_up = bytes_up.clone();
                        let bytes_down = bytes_down.clone();
                        tokio::spawn(async move {
                            if let Err(e) = socks::serve_connection(stream, &session, bytes_up, bytes_down).await {
                                if !closed.load(Ordering::Relaxed) {
                                    log::debug!("socks connection error: {e}");
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
    let _ = session
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;
    emit_status(&app, tunnel.id, &tunnel.name, TunnelStatus::Disconnected, None);
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

    let addr: (&str, u16) = (&tunnel.host, tunnel.port);
    let mut session = client::connect(config, addr, handler)
        .await
        .map_err(|e| format!("connect failed: {e}"))?;

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
