use tauri::menu::{CheckMenuItemBuilder, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::commands;
use crate::i18n::{self, Text};
use crate::events::TunnelStatus;
use crate::AppState;
use uuid::Uuid;

const TRAY_ID: &str = "main-tray";
const TOGGLE_WINDOW_ID: &str = "toggle-window";
const EXIT_ID: &str = "exit";
const UPDATE_ID: &str = "restart-to-update";
const TUNNEL_PREFIX: &str = "tunnel:";
const ACCESS_ID: &str = "network-access";
const TERMINAL_ID: &str = "open-terminal";
const ROUTER_ID: &str = "router";
const DISCONNECT_ALL_ID: &str = "disconnect-all";
const SHOW_WINDOW_ID: &str = "show-window";

/// Connected tunnels listed at the top level; the rest are counted.
const MAX_CONNECTED: usize = 10;
/// Recent (disconnected) tunnels at the top level.
const MAX_RECENT: usize = 5;
/// Remembered recent ids (more than shown: some may be connected or gone).
const KEEP_RECENT: usize = 20;
/// A group longer than this is split into alphabetical submenus.
const MAX_GROUP: usize = 30;

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let info = app.package_info();

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().cloned().unwrap())
        .menu(&menu)
        .tooltip(format!("{} v{}", info.name, info.version))
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if is_toggle_gesture(&event) {
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

/// One tunnel as the tray sees it.
#[derive(Clone, Debug, PartialEq)]
struct Entry {
    id: Uuid,
    name: String,
    group: Option<String>,
    running: bool,
    connecting: bool,
}

/// What the tray shows, decided without touching the menu API (tested below).
#[derive(Debug, PartialEq)]
struct Plan {
    /// Running tunnels (connected or retrying), at most `MAX_CONNECTED`.
    connected: Vec<Entry>,
    more_connected: usize,
    /// Recently used tunnels that are not running.
    recent: Vec<Entry>,
    /// Named groups sorted by name, then the ungrouped ones (`None`), each
    /// split in chunks of at most `MAX_GROUP`.
    groups: Vec<(Option<String>, Vec<Vec<Entry>>)>,
}

fn plan(entries: &[Entry], recent_ids: &[Uuid]) -> Plan {
    let running: Vec<Entry> = entries.iter().filter(|e| e.running).cloned().collect();
    let more_connected = running.len().saturating_sub(MAX_CONNECTED);
    let connected = running.into_iter().take(MAX_CONNECTED).collect();
    let recent = recent_ids
        .iter()
        .filter_map(|id| entries.iter().find(|e| e.id == *id && !e.running))
        .take(MAX_RECENT)
        .cloned()
        .collect();

    let mut names: Vec<String> = entries.iter().filter_map(|e| e.group.clone()).collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup();
    let mut groups: Vec<(Option<String>, Vec<Vec<Entry>>)> = names
        .into_iter()
        .map(|name| {
            let members = entries.iter().filter(|e| e.group.as_deref() == Some(&name)).cloned().collect();
            (Some(name), chunk(members))
        })
        .collect();
    let ungrouped: Vec<Entry> = entries.iter().filter(|e| e.group.is_none()).cloned().collect();
    if !ungrouped.is_empty() {
        groups.push((None, chunk(ungrouped)));
    }
    Plan { connected, more_connected, recent, groups }
}

/// List order (the user's) when it fits; a long list goes alphabetical and
/// is cut in chunks so no submenu runs off the screen.
fn chunk(mut members: Vec<Entry>) -> Vec<Vec<Entry>> {
    if members.len() <= MAX_GROUP {
        return vec![members];
    }
    members.sort_by_key(|e| e.name.to_lowercase());
    members.chunks(MAX_GROUP).map(<[Entry]>::to_vec).collect()
}

/// "A–F": first letters of a chunk's first and last names.
fn chunk_label(chunk: &[Entry]) -> String {
    let initial = |e: Option<&Entry>| {
        e.and_then(|e| e.name.chars().next())
            .map(|c| c.to_uppercase().to_string())
            .unwrap_or_default()
    };
    let (first, last) = (initial(chunk.first()), initial(chunk.last()));
    if first == last {
        first
    } else {
        format!("{first}–{last}")
    }
}

/// Moves `id` to the front of the tray's Recent (on every connect).
pub fn remember_recent(state: &AppState, id: Uuid) {
    if state.settings.get().tray_recent.first() == Some(&id) {
        return;
    }
    state.settings.modify_or_log(|s| {
        s.tray_recent.retain(|x| *x != id);
        s.tray_recent.insert(0, id);
        s.tray_recent.truncate(KEEP_RECENT);
    });
}

fn tunnel_item(app: &AppHandle, entry: &Entry) -> tauri::Result<tauri::menu::CheckMenuItem<Wry>> {
    let label = if entry.connecting {
        format!("{} · {}", entry.name, i18n::t(app, Text::Connecting))
    } else {
        entry.name.clone()
    };
    CheckMenuItemBuilder::with_id(format!("{TUNNEL_PREFIX}{}", entry.id), label)
        .checked(entry.running)
        .build(app)
}

fn group_submenu(app: &AppHandle, name: &Option<String>, chunks: &[Vec<Entry>]) -> tauri::Result<Submenu<Wry>> {
    let all: Vec<&Entry> = chunks.iter().flatten().collect();
    let running = all.iter().filter(|e| e.running).count();
    let title = name.clone().unwrap_or_else(|| i18n::t(app, Text::Ungrouped));
    let mut builder = SubmenuBuilder::new(app, format!("{title} ({running}/{})", all.len()));
    if chunks.len() == 1 {
        for entry in &chunks[0] {
            builder = builder.item(&tunnel_item(app, entry)?);
        }
    } else {
        for part in chunks {
            let mut sub = SubmenuBuilder::new(app, chunk_label(part));
            for entry in part {
                sub = sub.item(&tunnel_item(app, entry)?);
            }
            builder = builder.item(&sub.build()?);
        }
    }
    builder.build()
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItemBuilder::with_id(TOGGLE_WINDOW_ID, i18n::t(app, Text::ShowHide)).build(app)?)?;

    if crate::access::is_simple(app) {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        // Simple mode: the one switch the window shows, nothing per tunnel.
        menu.append(
            &CheckMenuItemBuilder::with_id(ACCESS_ID, i18n::t(app, Text::InternalNetwork))
                .checked(crate::access::is_on(app))
                .build(app)?,
        )?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    } else if let Some(state) = app.try_state::<AppState>() {
        menu.append(&MenuItemBuilder::with_id(TERMINAL_ID, i18n::t(app, Text::OpenTerminal)).build(app)?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        let tunnels = state.db.list().unwrap_or_default();
        let entries: Vec<Entry> = tunnels
            .iter()
            .map(|t| {
                let status = state.status(t.id);
                Entry {
                    id: t.id,
                    name: t.name.clone(),
                    group: t.group.clone(),
                    running: state.is_connected(t.id),
                    connecting: matches!(status, TunnelStatus::Connecting | TunnelStatus::Reconnecting),
                }
            })
            .collect();
        let plan = plan(&entries, &state.settings.get().tray_recent);

        if !plan.connected.is_empty() {
            for entry in &plan.connected {
                menu.append(&tunnel_item(app, entry)?)?;
            }
            if plan.more_connected > 0 {
                // Opens the window, where all of them are.
                menu.append(
                    &MenuItemBuilder::with_id(SHOW_WINDOW_ID, i18n::t_count(app, Text::MoreConnected, plan.more_connected))
                        .build(app)?,
                )?;
            }
            menu.append(&PredefinedMenuItem::separator(app)?)?;
        }
        if !plan.recent.is_empty() {
            menu.append(&MenuItemBuilder::new(i18n::t(app, Text::Recent)).enabled(false).build(app)?)?;
            for entry in &plan.recent {
                menu.append(&tunnel_item(app, entry)?)?;
            }
        }
        if !entries.is_empty() {
            let mut all = SubmenuBuilder::new(app, i18n::t(app, Text::AllTunnels));
            // One group (or none at all): its hosts directly, no extra level.
            if plan.groups.len() == 1 {
                let (_, chunks) = &plan.groups[0];
                if chunks.len() == 1 {
                    for entry in &chunks[0] {
                        all = all.item(&tunnel_item(app, entry)?);
                    }
                } else {
                    for part in chunks {
                        let mut sub = SubmenuBuilder::new(app, chunk_label(part));
                        for entry in part {
                            sub = sub.item(&tunnel_item(app, entry)?);
                        }
                        all = all.item(&sub.build()?);
                    }
                }
            } else {
                for (name, chunks) in &plan.groups {
                    all = all.item(&group_submenu(app, name, chunks)?);
                }
            }
            menu.append(&all.build()?)?;
            menu.append(&PredefinedMenuItem::separator(app)?)?;
        }

        menu.append(
            &CheckMenuItemBuilder::with_id(ROUTER_ID, i18n::t(app, Text::Router))
                .checked(state.router.running_port().is_some())
                .build(app)?,
        )?;
        menu.append(
            &MenuItemBuilder::with_id(DISCONNECT_ALL_ID, i18n::t(app, Text::DisconnectAll))
                .enabled(!state.running_ids().is_empty())
                .build(app)?,
        )?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }

    if let Some(version) = crate::updates::ready_version(app) {
        let label = i18n::t_version(app, Text::RestartToUpdate, &version);
        menu.append(&MenuItemBuilder::with_id(UPDATE_ID, label).build(app)?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }

    menu.append(&MenuItemBuilder::with_id(EXIT_ID, i18n::t(app, Text::Exit)).build(app)?)?;
    Ok(menu)
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    if id == TOGGLE_WINDOW_ID {
        toggle_window(app);
    } else if id == EXIT_ID {
        app.exit(0);
    } else if id == UPDATE_ID {
        // The main window asks first: tunnels and terminals are about to close.
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
        let _ = app.emit(crate::events::UPDATE_RESTART_REQUESTED_EVENT, ());
    } else if id == SHOW_WINDOW_ID {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    } else if id == TERMINAL_ID {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = commands::open_terminal_window(app, None).await;
        });
    } else if id == ROUTER_ID {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let on = app.state::<AppState>().router.running_port().is_some();
            let _ = commands::set_router_enabled(&app, !on).await;
            // A failure leaves the check mark where it was.
            rebuild_menu(&app);
        });
    } else if id == DISCONNECT_ALL_ID {
        let state = app.state::<AppState>();
        for id in state.running_ids() {
            state.stop(id);
        }
        rebuild_menu(app);
    } else if id == ACCESS_ID {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let on = crate::access::is_on(&app);
            let _ = crate::access::set(&app, !on).await;
            // A failure leaves the check mark where it was.
            rebuild_menu(&app);
        });
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

/// Double-click on Windows. The Linux StatusNotifierItem backend reports no
/// double-click — a single left click is "activate" there, by convention and
/// by protocol — so that is the gesture on Linux.
fn is_toggle_gesture(event: &TrayIconEvent) -> bool {
    if cfg!(target_os = "linux") {
        matches!(
            event,
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
        )
    } else {
        matches!(event, TrayIconEvent::DoubleClick { .. })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, group: Option<&str>, running: bool) -> Entry {
        Entry { id: Uuid::new_v4(), name: name.into(), group: group.map(Into::into), running, connecting: false }
    }

    #[test]
    fn connected_first_then_recent_not_running() {
        let a = entry("a", None, true);
        let b = entry("b", None, false);
        let c = entry("c", None, false);
        let p = plan(&[a.clone(), b.clone(), c.clone()], &[a.id, c.id, Uuid::new_v4(), b.id]);
        assert_eq!(p.connected, vec![a]);
        // A running tunnel and a deleted id are not in Recent.
        assert_eq!(p.recent, vec![c, b]);
    }

    #[test]
    fn connected_capped_and_counted() {
        let all: Vec<Entry> = (0..13).map(|i| entry(&format!("t{i}"), None, true)).collect();
        let p = plan(&all, &[]);
        assert_eq!(p.connected.len(), MAX_CONNECTED);
        assert_eq!(p.more_connected, 3);
    }

    #[test]
    fn groups_sorted_ungrouped_last_and_long_ones_split() {
        let mut all = vec![entry("x", None, false), entry("y", Some("beta"), false), entry("z", Some("Alpha"), false)];
        all.extend((0..65).map(|i| entry(&format!("h{i:02}"), Some("beta"), false)));
        let p = plan(&all, &[]);
        let names: Vec<_> = p.groups.iter().map(|(n, _)| n.clone()).collect();
        assert_eq!(names, vec![Some("Alpha".into()), Some("beta".into()), None]);
        let beta = &p.groups[1].1;
        assert_eq!(beta.iter().map(Vec::len).collect::<Vec<_>>(), vec![30, 30, 6]);
        assert!(beta[0].windows(2).all(|w| w[0].name.to_lowercase() <= w[1].name.to_lowercase()));
        assert_eq!(chunk_label(&beta[2]), "H–Y");
    }
}
