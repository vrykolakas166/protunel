//! The terminal window, its shells, and what it remembers (`terminal_memory.json`).

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

use crate::ssh::terminal::{self, TerminalExit, TerminalInput};
use crate::AppState;

/// Label of the terminal window; `lib.rs` tears its terminals down on destroy.
pub const TERMINAL_WINDOW: &str = "terminal";

/// How long a closed (hidden) terminal window is kept for a quick reopen
/// before its webview is destroyed to give the memory back.
const TERMINAL_KEEP_HIDDEN: std::time::Duration = std::time::Duration::from_secs(60);

/// Bumped on every hide and every open; a pending teardown only runs if it is
/// still the latest thing that happened to the window.
static TERMINAL_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Destroys the hidden terminal window after `TERMINAL_KEEP_HIDDEN`, unless
/// it was reopened in the meantime.
pub fn schedule_terminal_teardown(app: &AppHandle) {
    use std::sync::atomic::Ordering;
    let generation = TERMINAL_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(TERMINAL_KEEP_HIDDEN).await;
        if TERMINAL_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Some(window) = app.get_webview_window(TERMINAL_WINDOW) {
            if !window.is_visible().unwrap_or(true) {
                let _ = window.destroy();
            }
        }
    });
}

/// Shows the terminal window, creating it on first use. Async on purpose:
/// building a window from a sync command deadlocks on Windows.
#[tauri::command]
pub async fn open_terminal_window(app: AppHandle) -> Result<(), String> {
    // Cancels a pending teardown of the hidden window.
    TERMINAL_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(TERMINAL_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let built = WebviewWindowBuilder::new(&app, TERMINAL_WINDOW, WebviewUrl::App("terminal.html".into()))
        .title("protunel — Terminal")
        .inner_size(1180.0, 740.0)
        .min_inner_size(640.0, 400.0)
        .build();
    match built {
        Ok(window) => harden_webview(&window),
        // Two quick clicks both found no window and both tried to build it;
        // the one that lost just shows the winner's.
        Err(e) => {
            let window = app.get_webview_window(TERMINAL_WINDOW).ok_or_else(|| e.to_string())?;
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    Ok(())
}

/// Turns off WebView2's browser shortcuts (F5/Ctrl+R reload, Ctrl+F find,
/// Ctrl+P print, F7 caret browsing, Ctrl+Shift+I…) so a keystroke can never
/// reach the browser instead of the app — a reload would drop every open
/// shell. Release builds only: in development reload and devtools are wanted.
/// WebKitGTK has no such built-in shortcuts; the terminal page also cancels
/// stray keys itself on every platform.
pub fn harden_webview(window: &tauri::WebviewWindow) {
    #[cfg(all(windows, not(debug_assertions)))]
    {
        let _ = window.with_webview(|webview| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
            use windows_core::Interface;
            let Ok(core) = webview.controller().CoreWebView2() else { return };
            let Ok(settings) = core.Settings() else { return };
            if let Ok(settings) = settings.cast::<ICoreWebView2Settings3>() {
                let _ = settings.SetAreBrowserAcceleratorKeysEnabled(false);
            }
        });
    }
    #[cfg(not(all(windows, not(debug_assertions))))]
    let _ = window;
}

#[tauri::command]
pub async fn terminal_open(
    app: AppHandle,
    state: State<'_, AppState>,
    tunnel_id: Uuid,
    cols: u32,
    rows: u32,
    on_output: Channel<InvokeResponseBody>,
    on_exit: Channel<TerminalExit>,
) -> Result<Uuid, String> {
    terminal::open(&app, &state, tunnel_id, cols, rows, on_output, on_exit).await
}

#[tauri::command]
pub fn terminal_write(state: State<AppState>, id: Uuid, data: String) -> Result<(), String> {
    state.terminals.send(id, TerminalInput::Data(data.into_bytes()))
}

#[tauri::command]
pub fn terminal_write_many(state: State<AppState>, ids: Vec<Uuid>, data: String) -> Result<(), String> {
    state.terminals.send_many(&ids, data.as_bytes())
}

#[tauri::command]
pub fn terminal_resize(state: State<AppState>, id: Uuid, cols: u32, rows: u32) -> Result<(), String> {
    state.terminals.send(id, TerminalInput::Resize { cols, rows })
}

#[tauri::command]
pub fn terminal_close(state: State<AppState>, id: Uuid) -> Result<(), String> {
    // Already gone (shell exited first) is the outcome the caller wanted.
    let _ = state.terminals.send(id, TerminalInput::Close);
    Ok(())
}

#[tauri::command]
pub fn get_terminal_memory(state: State<AppState>) -> crate::settings::TerminalMemory {
    state.terminal_memory.get()
}

#[tauri::command]
pub fn save_terminal_memory(state: State<AppState>, memory: crate::settings::TerminalMemory) -> Result<(), String> {
    state.terminal_memory.update(memory)
}

/// "Forget remembered commands" in settings: keeps the workspaces.
#[tauri::command]
pub fn clear_terminal_commands(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let mut memory = state.terminal_memory.get();
    memory.hosts.clear();
    state.terminal_memory.update(memory)?;
    let _ = app.emit(crate::events::TERMINAL_MEMORY_CLEARED_EVENT, ());
    Ok(())
}

/// A long command finished while its pane was out of sight.
#[tauri::command]
pub fn terminal_notify(app: AppHandle, state: State<AppState>, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    if !state.settings.get().notifications_enabled {
        return;
    }
    let _ = app.notification().builder().title(title).body(body).show();
}
