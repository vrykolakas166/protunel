use russh::client;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::net::TcpStream;

use super::counting_stream::CountingStream;
use super::SshHandler;

/// Opens an SSH `direct-tcpip` channel to a fixed remote target and pipes bytes
/// bidirectionally with an accepted local connection. This is the static "-L local
/// forward" counterpart to `socks::serve_connection`'s dynamic SOCKS5 forwarding.
pub async fn serve_forward_connection(
    stream: TcpStream,
    session: &client::Handle<SshHandler>,
    remote_host: &str,
    remote_port: u16,
    bytes_up: Arc<AtomicU64>,
    bytes_down: Arc<AtomicU64>,
) -> anyhow::Result<()> {
    let channel = session
        .channel_open_direct_tcpip(remote_host, remote_port as u32, "127.0.0.1", 0)
        .await?;

    let mut client_stream = CountingStream::new(stream, bytes_up);
    let mut channel_stream = CountingStream::new(channel.into_stream(), bytes_down);

    tokio::io::copy_bidirectional(&mut client_stream, &mut channel_stream).await?;
    Ok(())
}
