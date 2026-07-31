use fast_socks5::server::{DnsResolveHelper as _, Socks5ServerProtocol};
use fast_socks5::{ReplyError, Socks5Command};
use russh::client;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, ToSocketAddrs};
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::net::TcpStream;

use super::counting_stream::CountingStream;
use super::SshHandler;

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
    let (proto, cmd, target_addr) = Socks5ServerProtocol::accept_no_auth(stream)
        .await?
        .read_command()
        .await?
        .resolve_dns()
        .await?;

    if cmd != Socks5Command::TCPConnect {
        proto.reply_error(&ReplyError::CommandNotSupported).await?;
        return Ok(());
    }

    let target_socket: SocketAddr = target_addr
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| anyhow::anyhow!("no resolved address for {target_addr}"))?;

    let channel = match session
        .channel_open_direct_tcpip(
            target_socket.ip().to_string(),
            target_socket.port() as u32,
            "127.0.0.1",
            0,
        )
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
    let channel_stream = channel.into_stream();

    let mut client_stream = CountingStream::new(client_stream, bytes_up);
    let mut channel_stream = CountingStream::new(channel_stream, bytes_down);

    tokio::io::copy_bidirectional(&mut client_stream, &mut channel_stream).await?;
    Ok(())
}
