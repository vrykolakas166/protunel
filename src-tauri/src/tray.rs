use tauri::menu::{CheckMenuItemBuilder, Menu, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::commands;
use crate::AppState;

const TRAY_ID: &str = "main-tray";
const TOGGLE_WINDOW_ID: &str = "toggle-window";
const EXIT_ID: &str = "exit";
const TUNNEL_PREFIX: &str = "tunnel:";

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().cloned().unwrap())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick { .. } = event {
                toggle_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// Rebuilds the tray's tunnel submenu to reflect the current list and connection
/// state. Called after add/edit/delete and on every status transition.
pub fn rebuild_menu(app: &AppHandle) {
    if let (Ok(menu), Some(tray)) = (build_menu(app), app.tray_by_id(TRAY_ID)) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItemBuilder::with_id(TOGGLE_WINDOW_ID, "Show/Hide").build(app)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(tunnels) = state.db.list() {
            if !tunnels.is_empty() {
                for tunnel in &tunnels {
                    let id = format!("{TUNNEL_PREFIX}{}", tunnel.id);
                    let checked = state.is_connected(tunnel.id);
                    menu.append(
                        &CheckMenuItemBuilder::with_id(id, &tunnel.name)
                            .checked(checked)
                            .build(app)?,
                    )?;
                }
                menu.append(&PredefinedMenuItem::separator(app)?)?;
            }
        }
    }

    menu.append(&MenuItemBuilder::with_id(EXIT_ID, "Exit").build(app)?)?;
    Ok(menu)
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    if id == TOGGLE_WINDOW_ID {
        toggle_window(app);
    } else if id == EXIT_ID {
        app.exit(0);
    } else if let Some(tunnel_id) = id.strip_prefix(TUNNEL_PREFIX) {
        if let Ok(uuid) = tunnel_id.parse() {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let already_connected = app.state::<AppState>().is_connected(uuid);
                if already_connected {
                    app.state::<AppState>().stop(uuid);
                } else {
                    let _ = commands::connect_tunnel(app.clone(), app.state::<AppState>(), uuid).await;
                }
                rebuild_menu(&app);
            });
        }
    }
}

fn toggle_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}
