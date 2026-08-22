use russh::client;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::net::TcpStream;

use super::pipe::pipe_streams;
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

    pipe_streams(stream, channel.into_stream(), bytes_up, bytes_down).await
}
