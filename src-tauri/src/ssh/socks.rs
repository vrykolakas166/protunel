use fast_socks5::server::Socks5ServerProtocol;
use fast_socks5::util::target_addr::TargetAddr;
use fast_socks5::{ReplyError, Socks5Command};
use russh::client;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::net::TcpStream;

use super::pipe::pipe_streams;
use super::SshHandler;

/// Splits a SOCKS5 destination into the host string and port to hand to
/// `direct-tcpip`. A domain target keeps its **hostname**: the SSH server does
/// the lookup, so internal-only names resolve and DNS never leaves the tunnel.
pub fn target_parts(target: &TargetAddr) -> (String, u16) {
    match target {
        TargetAddr::Ip(addr) => (addr.ip().to_string(), addr.port()),
        TargetAddr::Domain(host, port) => (host.clone(), *port),
    }
}

/// Handles one accepted local SOCKS5 client connection: negotiates the SOCKS5
/// handshake, opens an SSH `direct-tcpip` channel to the requested target through
/// the shared session, and pipes bytes bidirectionally. This is the "-D dynamic
/// forward" behavior, reimplemented without shelling out to plink.exe. Bytes read
/// from each side are attributed to the tunnel's shared up/down counters.
pub async fn serve_connection(
    stream: TcpStream,
    session: &client::Handle<SshHandler>,
    bytes_up: Arc<AtomicU64>,
    bytes_down: Arc<AtomicU64>,
) -> anyhow::Result<()> {
    // Deliberately no `resolve_dns()` here: resolving locally would leak DNS and
    // break names that only exist on the far side of the tunnel.
    let (proto, cmd, target_addr) = Socks5ServerProtocol::accept_no_auth(stream)
        .await?
        .read_command()
        .await?;

    if cmd != Socks5Command::TCPConnect {
        proto.reply_error(&ReplyError::CommandNotSupported).await?;
        return Ok(());
    }

    let (host, port) = target_parts(&target_addr);

    // Opened before the success reply so a refused destination comes back as a
    // proper SOCKS error instead of a connection that dies right after handshake.
    let channel = match session
        .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
        .await
    {
        Ok(channel) => channel,
        Err(e) => {
            proto.reply_error(&ReplyError::HostUnreachable).await?;
            return Err(e.into());
        }
    };

    let local_bind = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 0);
    let client_stream = proto.reply_success(local_bind).await?;

    pipe_streams(client_stream, channel.into_stream(), bytes_up, bytes_down).await
}
