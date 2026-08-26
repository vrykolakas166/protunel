use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fast_socks5::server::Socks5ServerProtocol;
use fast_socks5::util::target_addr::TargetAddr;
use fast_socks5::{ReplyError, Socks5Command};
use russh::client;
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::rules::{RuleAction, Target};
use super::RoutingDecision;
use crate::events::{RouterStatsEvent, ROUTER_STATS_EVENT};
use crate::ssh::counting_stream::CountingStream;
use crate::ssh::pipe::pipe_streams;
use crate::ssh::socks::target_parts;
use crate::ssh::SshHandler;
use crate::AppState;

/// How long a routed request waits for an on-demand tunnel to authenticate before
/// giving up. Matches the jump-tunnel chain timeout in `commands::connect_one`.
const ON_DEMAND_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// Starts the accept loop and the stats ticker. Both stop when `cancel` fires.
pub fn spawn(app: AppHandle, listener: TcpListener, cancel: CancellationToken) {
    let stats_app = app.clone();
    let stats_cancel = cancel.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                _ = stats_cancel.cancelled() => break,
                _ = tick.tick() => {
                    let Some(state) = stats_app.try_state::<AppState>() else { break };
                    let _ = stats_app.emit(
                        ROUTER_STATS_EVENT,
                        RouterStatsEvent {
                            bytes_up: state.router.bytes_up.load(Ordering::Relaxed),
                            bytes_down: state.router.bytes_down.load(Ordering::Relaxed),
                            active_connections: state.router.active_connections.load(Ordering::Relaxed),
                        },
                    );
                }
            }
        }
    });

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                accepted = listener.accept() => {
                    let Ok((stream, _addr)) = accepted else { break };
                    let app = app.clone();
                    // Stopping the router drops in-flight connections too — the
                    // system proxy is being torn down under them anyway, so
                    // letting them linger would just hang apps on a dead route.
                    let cancel = cancel.clone();
                    tokio::spawn(async move {
                        tokio::select! {
                            _ = cancel.cancelled() => {}
                            _ = handle_connection(app, stream) => {}
                        }
                    });
                }
            }
        }
    });
}

async fn handle_connection(app: AppHandle, stream: TcpStream) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    state.router.active_connections.fetch_add(1, Ordering::Relaxed);
    let result = route(&app, &state, stream).await;
    state.router.active_connections.fetch_sub(1, Ordering::Relaxed);

    if let Err(e) = result {
        eprintln!("[router] {e}");
    }
}

async fn route(app: &AppHandle, state: &AppState, stream: TcpStream) -> anyhow::Result<()> {
    // Captured processes reach the router over loopback, so the ephemeral
    // port the OS assigned their socket is exactly the peer port seen here —
    // grabbed before `stream` moves into the SOCKS5 protocol wrapper below,
    // since TcpStream itself is what exposes peer_addr().
    let peer_port = stream.peer_addr().ok().map(|a| a.port());

    // No `resolve_dns()`: the hostname the client asked for is exactly what the
    // rules match on, and what the SSH server should resolve on the far side.
    let (proto, cmd, target_addr) = Socks5ServerProtocol::accept_no_auth(stream)
        .await?
        .read_command()
        .await?;

    if cmd != Socks5Command::TCPConnect {
        proto.reply_error(&ReplyError::CommandNotSupported).await?;
        return Ok(());
    }

    let (host, port) = target_parts(&target_addr);
    let target = match &target_addr {
        TargetAddr::Ip(addr) => Target::Ip(addr.ip(), addr.port()),
        TargetAddr::Domain(host, port) => Target::Domain(host.clone(), *port),
    };
    let outcome = state.router.evaluate(&target).await;

    let mut decision = RoutingDecision {
        at: now_secs(),
        host: host.clone(),
        port,
        rule_id: outcome.rule_id,
        action: outcome.action,
        target_tunnel_id: outcome.target_tunnel_id,
        outcome: "ok".to_string(),
    };

    let served = match outcome.action {
        RuleAction::Block => {
            proto.reply_error(&ReplyError::ConnectionNotAllowed).await?;
            decision.outcome = "blocked by rule".to_string();
            attribute_to_capture(state, peer_port, &decision);
            state.router.record_decision(decision);
            return Ok(());
        }
        RuleAction::Direct => serve_direct(state, proto, &host, port).await,
        RuleAction::Tunnel => match outcome.target_tunnel_id {
            Some(tunnel_id) => serve_via_tunnel(app, state, proto, tunnel_id, &host, port).await,
            None => Err(anyhow::anyhow!("rule routes to a tunnel but names none")),
        },
    };

    match &served {
        Ok(()) => {}
        Err(e) => decision.outcome = e.to_string(),
    }
    attribute_to_capture(state, peer_port, &decision);
    state.router.record_decision(decision);
    served
}

/// Bypasses every tunnel and dials from this machine. Traffic still counts
/// toward the router's own totals so the panel shows the full picture.
async fn serve_direct(
    state: &AppState,
    proto: Socks5ServerProtocol<TcpStream, fast_socks5::server::states::CommandRead>,
    host: &str,
    port: u16,
) -> anyhow::Result<()> {
    let remote = match TcpStream::connect((host, port)).await {
        Ok(remote) => remote,
        Err(e) => {
            proto.reply_error(&ReplyError::HostUnreachable).await?;
            return Err(e.into());
        }
    };

    let local_bind = remote.local_addr()?;
    let client = proto.reply_success(local_bind).await?;
    pipe_streams(
        client,
        remote,
        state.router.bytes_up.clone(),
        state.router.bytes_down.clone(),
    )
    .await
}

/// Routes through a tunnel's SSH session, dialing the tunnel on demand if it is
/// not up yet. Bytes are counted twice on purpose: once against the tunnel (so
/// its row in the list reflects routed traffic) and once against the router.
async fn serve_via_tunnel(
    app: &AppHandle,
    state: &AppState,
    proto: Socks5ServerProtocol<TcpStream, fast_socks5::server::states::CommandRead>,
    tunnel_id: Uuid,
    host: &str,
    port: u16,
) -> anyhow::Result<()> {
    let session = match ensure_session(app, state, tunnel_id).await {
        Ok(session) => session,
        Err(e) => {
            proto.reply_error(&ReplyError::HostUnreachable).await?;
            return Err(anyhow::anyhow!(e));
        }
    };

    let channel = match session
        .channel_open_direct_tcpip(host.to_string(), port as u32, "127.0.0.1", 0)
        .await
    {
        Ok(channel) => channel,
        Err(e) => {
            proto.reply_error(&ReplyError::HostUnreachable).await?;
            return Err(e.into());
        }
    };

    let local_bind = std::net::SocketAddr::from(([127, 0, 0, 1], 0));
    let client = proto.reply_success(local_bind).await?;

    let (tunnel_up, tunnel_down) = state
        .counters_for(tunnel_id)
        .unwrap_or_else(|| (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0))));

    // Outer wrappers feed the router totals, inner ones the tunnel's own stats.
    let client = CountingStream::new(client, state.router.bytes_up.clone());
    let remote = CountingStream::new(channel.into_stream(), state.router.bytes_down.clone());
    pipe_streams(client, remote, tunnel_up, tunnel_down).await
}

/// Returns a live authenticated session for `tunnel_id`, connecting the tunnel
/// first if needed.
///
/// The connect path is serialized: without the lock, a browser opening six
/// connections at once would race six `connect_one` calls through the
/// `is_connected` check and leave five orphaned tunnel tasks fighting over the
/// same local ports.
async fn ensure_session(
    app: &AppHandle,
    state: &AppState,
    tunnel_id: Uuid,
) -> Result<Arc<client::Handle<SshHandler>>, String> {
    if let Some(session) = state.session_for(tunnel_id) {
        return Ok(session);
    }

    let _guard = state.router.connect_lock.lock().await;
    if let Some(session) = state.session_for(tunnel_id) {
        return Ok(session);
    }

    crate::commands::connect_one(app, state, tunnel_id).await?;
    crate::commands::wait_for_session(state, tunnel_id, ON_DEMAND_CONNECT_TIMEOUT).await?;
    state
        .session_for(tunnel_id)
        .ok_or_else(|| "tunnel connected but has no session".to_string())
}

/// Attributes a routed connection to a captured process, if any capture is
/// active — gated behind `has_active()` so ordinary SOCKS5 clients (browsers,
/// tools using `--socks5-hostname`) never pay for a PID-table walk.
fn attribute_to_capture(state: &AppState, peer_port: Option<u16>, decision: &RoutingDecision) {
    if !state.capture.has_active() {
        return;
    }
    let Some(port) = peer_port else { return };
    if let Some(pid) = crate::capture::pid_lookup::owning_pid(port) {
        state.capture.record_connection(pid, decision);
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
