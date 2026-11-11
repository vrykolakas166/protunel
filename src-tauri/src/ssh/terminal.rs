//! Interactive shells (PTY + shell channel) over a tunnel's live SSH session.
//!
//! A terminal never owns a connection: it opens a `session` channel on the
//! tunnel's authenticated `client::Handle`, so it reuses the supervisor's
//! reconnect loop, jump chain, host-key prompt and credentials. The trade-off is
//! that a terminal dies with its session; the frontend offers a reconnect.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use russh::ChannelMsg;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::events::TunnelStatus;
use crate::AppState;

/// Upper bound on one output message to the webview. Bursts (`cat` of a big
/// file) coalesce up to this; a lone keystroke echo is sent immediately.
const MAX_FLUSH_BYTES: usize = 64 * 1024;

/// Covers the 120s host-key prompt on a first connect plus the handshake.
const SESSION_WAIT: Duration = Duration::from_secs(150);

pub enum TerminalInput {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExit {
    /// The remote shell's exit code, when the server reported one.
    pub exit_status: Option<u32>,
    /// Why the terminal ended abnormally (session lost, write failed).
    pub message: Option<String>,
}

/// Input senders of every open terminal, keyed by terminal id.
#[derive(Default)]
pub struct Terminals(Mutex<HashMap<Uuid, mpsc::UnboundedSender<TerminalInput>>>);

impl Terminals {
    pub fn send(&self, id: Uuid, input: TerminalInput) -> Result<(), String> {
        let map = self.0.lock().unwrap();
        let tx = map.get(&id).ok_or("terminal is not open")?;
        tx.send(input).map_err(|_| "terminal is closed".to_string())
    }

    /// Broadcast: the same bytes to several terminals, in one IPC call so every
    /// shell sees keystrokes in the same order. Terminals that already ended
    /// are skipped; it only fails when none of them took the input.
    pub fn send_many(&self, ids: &[Uuid], data: &[u8]) -> Result<(), String> {
        let map = self.0.lock().unwrap();
        let delivered = ids
            .iter()
            .filter_map(|id| map.get(id))
            .filter(|tx| tx.send(TerminalInput::Data(data.to_vec())).is_ok())
            .count();
        if delivered == 0 && !ids.is_empty() {
            return Err("no open terminal to send to".to_string());
        }
        Ok(())
    }

    /// Closes every terminal, e.g. when the terminal window is destroyed and
    /// nobody is left to read their output.
    pub fn close_all(&self) {
        for (_, tx) in self.0.lock().unwrap().drain() {
            let _ = tx.send(TerminalInput::Close);
        }
    }

    fn insert(&self, id: Uuid, tx: mpsc::UnboundedSender<TerminalInput>) {
        self.0.lock().unwrap().insert(id, tx);
    }

    fn remove(&self, id: Uuid) {
        self.0.lock().unwrap().remove(&id);
    }
}

/// Connects the tunnel if needed, opens a PTY shell on its session, and spawns
/// the task that pumps bytes both ways. Returns the new terminal's id.
pub async fn open(
    app: &AppHandle,
    state: &AppState,
    tunnel_id: Uuid,
    cols: u32,
    rows: u32,
    output: Channel<InvokeResponseBody>,
    exit: Channel<TerminalExit>,
) -> Result<Uuid, String> {
    crate::commands::connect_one(app, state, tunnel_id).await?;
    if let Err(e) = crate::commands::wait_for_session(state, tunnel_id, SESSION_WAIT).await {
        // The supervisor's own error (auth failed, host key rejected…) says far
        // more than "disconnected before it finished connecting".
        return Err(last_error(state, tunnel_id).unwrap_or(e));
    }
    let session = state
        .session_for(tunnel_id)
        .ok_or("tunnel is not connected")?;

    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("failed to open shell channel: {e}"))?;
    channel
        .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(|e| format!("failed to request a terminal: {e}"))?;
    channel
        .request_shell(false)
        .await
        .map_err(|e| format!("failed to start shell: {e}"))?;

    let (mut reader, writer) = channel.split();
    let id = Uuid::new_v4();
    let (tx, mut rx) = mpsc::unbounded_channel();
    state.terminals.insert(id, tx);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut exit_status = None;
        let message: Option<String> = loop {
            tokio::select! {
                msg = reader.wait() => {
                    let Some(msg) = msg else { break Some("connection closed".to_string()) };
                    let mut buf = Vec::new();
                    let mut closed = absorb(msg, &mut buf, &mut exit_status);
                    // Take whatever has already arrived without waiting for more,
                    // so a burst goes out as one IPC message while a single echo
                    // is never held back by a timer.
                    while !closed && buf.len() < MAX_FLUSH_BYTES {
                        let next = tokio::select! {
                            biased;
                            m = reader.wait() => Some(m),
                            _ = std::future::ready(()) => None,
                        };
                        match next {
                            None => break,
                            Some(None) => closed = true,
                            Some(Some(m)) => closed = absorb(m, &mut buf, &mut exit_status),
                        }
                    }
                    if !buf.is_empty() && output.send(InvokeResponseBody::Raw(buf)).is_err() {
                        let _ = writer.close().await;
                        break None;
                    }
                    if closed {
                        break None;
                    }
                }
                input = rx.recv() => match input {
                    Some(TerminalInput::Data(bytes)) => {
                        if let Err(e) = writer.data_bytes(bytes).await {
                            break Some(format!("write failed: {e}"));
                        }
                    }
                    Some(TerminalInput::Resize { cols, rows }) => {
                        let _ = writer.window_change(cols, rows, 0, 0).await;
                    }
                    Some(TerminalInput::Close) | None => {
                        let _ = writer.close().await;
                        break None;
                    }
                },
            }
        };
        if let Some(state) = app.try_state::<AppState>() {
            state.terminals.remove(id);
        }
        let _ = exit.send(TerminalExit { exit_status, message });
    });

    Ok(id)
}

/// Folds one channel message into the pending output. Returns true once the
/// channel is finished.
fn absorb(msg: ChannelMsg, buf: &mut Vec<u8>, exit_status: &mut Option<u32>) -> bool {
    match msg {
        ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
            buf.extend_from_slice(&data);
            false
        }
        ChannelMsg::ExitStatus { exit_status: code } => {
            *exit_status = Some(code);
            false
        }
        ChannelMsg::Close => true,
        _ => false,
    }
}

fn last_error(state: &AppState, tunnel_id: Uuid) -> Option<String> {
    state
        .statuses()
        .into_iter()
        .find(|s| s.tunnel_id == tunnel_id && s.status == TunnelStatus::Error)
        .and_then(|s| s.message)
}
