use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncWrite};

use super::counting_stream::CountingStream;

/// Pumps bytes between an accepted local client and whatever is carrying them to
/// the destination — an SSH `direct-tcpip` channel, or a plain TCP socket when the
/// router sends a connection DIRECT.
///
/// Bytes *read from* the client count as up, bytes *read from* the remote count as
/// down, matching how per-tunnel stats have always been attributed.
pub async fn pipe_streams<C, R>(
    client: C,
    remote: R,
    bytes_up: Arc<AtomicU64>,
    bytes_down: Arc<AtomicU64>,
) -> anyhow::Result<()>
where
    C: AsyncRead + AsyncWrite + Unpin,
    R: AsyncRead + AsyncWrite + Unpin,
{
    let mut client = CountingStream::new(client, bytes_up);
    let mut remote = CountingStream::new(remote, bytes_down);
    tokio::io::copy_bidirectional(&mut client, &mut remote).await?;
    Ok(())
}
