//! Every `#[tauri::command]`: the IPC surface, one file per subject. Each
//! file's items are re-exported here, so callers (and `lib.rs`'s
//! `generate_handler!`) keep using `commands::name`.

use tauri::{AppHandle, Emitter};

use crate::events::TUNNELS_CHANGED_EVENT;

mod tunnels;
mod connection;
mod host_keys;
mod terminal_window;
mod app_update;
mod dev_tools;
mod router_rules;
mod app_settings;
mod process_capture;
mod files;

pub use tunnels::*;
pub use connection::*;
pub use host_keys::*;
pub use terminal_window::*;
pub use app_update::*;
pub use dev_tools::*;
pub use router_rules::*;
pub use app_settings::*;
pub use process_capture::*;
pub use files::*;

/// Rebuilds the tray and tells every window to reload its tunnel list. Call
/// after any change to the set of tunnels or their names/hosts.
pub fn tunnels_changed(app: &AppHandle) {
    crate::tray::rebuild_menu(app);
    let _ = app.emit(TUNNELS_CHANGED_EVENT, ());
}
