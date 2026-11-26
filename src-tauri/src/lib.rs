mod access;
mod capture;
mod commands;
mod config_io;
mod db;
mod events;
mod i18n;
mod network;
mod platform;
mod router;
mod secrets;
mod settings;
mod ssh;
mod tray;
mod tunnel;
mod updates;
mod window_anim;
mod winscp;

#[cfg(test)]
mod it;

use tauri::{Emitter, Manager, RunEvent};
pub use tunnel::AppState;

/// WebKitGTK's DMA-BUF renderer draws a blank white window on the NVIDIA
/// proprietary driver (common on Arch + Wayland compositors). Falling back to
/// the older renderer costs a little GPU efficiency and fixes it. Only on
/// NVIDIA, and never over a value the user set themselves. Runs first thing,
/// before any thread exists, which is what makes `set_var` sound.
#[cfg(target_os = "linux")]
fn work_around_nvidia_dmabuf() {
    const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    if std::env::var_os(VAR).is_none() && std::path::Path::new("/proc/driver/nvidia").exists() {
        std::env::set_var(VAR, "1");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    work_around_nvidia_dmabuf();

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    let app = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![commands::AUTOSTART_ARG]),
        ))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db = db::Db::open(&data_dir.join("protunel.db"))?;
            app.manage(AppState::new(&data_dir, db));
            app.manage(updates::Updates::default());
            app.manage(ssh::sftp::Files::default());
            tray::setup(app.handle())?;
            if let Some(main) = app.get_webview_window("main") {
                commands::harden_webview(&main);
                // The window starts hidden (tauri.conf.json) so a sign-in
                // launch set to "start minimized" never flashes it.
                let from_autostart = std::env::args().any(|arg| arg == commands::AUTOSTART_ARG);
                let settings = app.state::<AppState>().settings.get();
                // A restart into an update always shows the window, even when
                // the old instance was started minimized at sign-in.
                if !(from_autostart && settings.start_minimized) || updates::just_updated(app.handle()) {
                    let _ = main.show();
                }
                // Entries written by older versions start the app without
                // AUTOSTART_ARG; rewrite them so the flag above can be seen.
                if settings.autostart_enabled {
                    commands::refresh_autostart(app.handle());
                }
            }

            // Undo a system proxy left behind by a previous run that was killed
            // before it could clean up. Must happen before the router starts, or
            // recovery would restore over our own fresh settings.
            router::system_proxy::recover(app.handle());

            updates::start(app.handle());
            updates::connect_on_launch(app.handle());

            let state = app.state::<AppState>();
            let _ = state.router.reload_rules(&state.db);
            if state.router.config().enabled {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    match router::start(&handle).await {
                        // Simple mode's switch was left on: bring its tunnels
                        // up too, as the switch itself does.
                        Ok(()) if access::is_simple(&handle) => {
                            access::connect_routed(&handle);
                            tray::rebuild_menu(&handle);
                        }
                        Ok(()) => {}
                        Err(e) => router::emit_status(
                            &handle,
                            events::RouterStatus::Error,
                            None,
                            Some(e),
                        ),
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing the main window hides it to the tray, unless the user
            // chose "quit on close": then it exits like the tray's Exit (the
            // same `RunEvent::Exit` cleanup runs).
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                api.prevent_close();
                let to_tray = window
                    .app_handle()
                    .try_state::<AppState>()
                    .is_none_or(|s| s.settings.get().close_to_tray);
                if to_tray {
                    let _ = window.hide();
                } else {
                    // Quitting closes every tunnel and shell: the page asks
                    // first, then calls `quit_app`.
                    let _ = window.emit_to(window.label(), events::APP_CLOSE_REQUESTED_EVENT, ());
                }
            }
            // The terminal window is hidden too, but its shells close as if it
            // had been destroyed. Tearing the webview down and building a new
            // one on every close/open is what made quick reopening lag (and a
            // reopen racing the teardown could show nothing at all).
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == commands::TERMINAL_WINDOW => {
                api.prevent_close();
                if commands::terminal_has_unsaved() {
                    // An editor holds unsaved changes: the page asks, then calls
                    // `terminal_window_hide` if the answer is "close anyway".
                    let _ = window.emit_to(window.label(), events::TERMINAL_CLOSE_REQUESTED_EVENT, ());
                } else {
                    commands::hide_terminal_window(window.app_handle());
                }
            }
            // Its terminals would otherwise keep shells open on the server with
            // nobody left to read them.
            tauri::WindowEvent::Destroyed if window.label() == commands::TERMINAL_WINDOW => {
                window.state::<AppState>().terminals.close_all();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_tunnels,
            commands::list_tunnel_statuses,
            commands::add_tunnel,
            commands::add_tunnels,
            commands::update_tunnel,
            commands::delete_tunnel,
            commands::reorder_tunnels,
            commands::set_tunnels_group,
            commands::set_tunnel_bookmarks,
            commands::add_port_forward,
            commands::delete_port_forward,
            commands::connect_tunnel,
            commands::disconnect_tunnel,
            commands::connect_all,
            commands::disconnect_all,
            commands::confirm_host_key,
            commands::reject_host_key,
            commands::list_known_hosts,
            commands::forget_known_host,
            commands::list_host_key_mismatches,
            commands::update_status,
            commands::check_for_updates,
            commands::download_update,
            commands::install_update,
            commands::take_whats_new,
            commands::set_network_access,
            commands::dev_tools_enabled,
            commands::debug_simulate_update,
            commands::debug_whats_new,
            commands::debug_fail_tunnel,
            commands::get_settings,
            commands::get_terminal_memory,
            commands::save_terminal_memory,
            commands::clear_terminal_commands,
            commands::terminal_notify,
            commands::update_settings,
            commands::get_router_config,
            commands::update_router_config,
            commands::router_snapshot,
            commands::list_router_rules,
            commands::add_router_rule,
            commands::update_router_rule,
            commands::delete_router_rule,
            commands::reorder_router_rules,
            commands::list_router_decisions,
            commands::pick_capture_target,
            commands::launch_capture,
            commands::stop_capture,
            commands::list_active_captures,
            commands::list_recent_captures,
            commands::list_capture_connections,
            commands::open_terminal_window,
            window_anim::animate_window,
            commands::terminal_open,
            commands::terminal_write,
            commands::terminal_write_many,
            commands::terminal_resize,
            commands::terminal_close,
            commands::terminal_set_unsaved,
            commands::terminal_window_hide,
            commands::quit_app,
            commands::files_home,
            commands::files_list,
            commands::files_properties,
            commands::files_dir_size,
            commands::files_create,
            commands::files_rename,
            commands::files_count,
            commands::files_delete,
            commands::files_paste,
            commands::files_copy_across,
            commands::files_read_text,
            commands::files_read_image,
            commands::files_write_text,
            commands::files_upload,
            commands::files_existing,
            commands::files_retry,
            commands::files_pick_upload,
            commands::files_download,
            commands::files_pick_download,
            commands::files_drag_out,
            commands::files_open_local,
            commands::files_transfers,
            commands::files_cancel_transfer,
            commands::files_clear_transfers,
            commands::files_reveal,
            commands::files_save_draft,
            config_io::export_config,
            config_io::pick_import_file,
            config_io::preview_import,
            config_io::apply_import,
            winscp::winscp_preview,
            winscp::winscp_cancel,
            winscp::winscp_import,
            network::list_local_ips,
            platform::platform_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|app_handle, event| {
        // Tray "Exit" calls app.exit(0), which lands here. This is the only
        // clean-shutdown hook, and the system proxy must not outlive the app.
        if let RunEvent::Exit = event {
            router::system_proxy::cleanup_on_exit(app_handle);
            updates::install_on_exit(app_handle);
        }
    });
}
