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
            tray::setup(app.handle())?;
            if let Some(main) = app.get_webview_window("main") {
                commands::harden_webview(&main);
                // The window starts hidden (tauri.conf.json) so a sign-in
                // launch set to "start minimized" never flashes it.
                let from_autostart = std::env::args().any(|arg| arg == commands::AUTOSTART_ARG);
                let settings = app.state::<AppState>().settings.get();
                if !(from_autostart && settings.start_minimized) {
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
            // Closing the main window only hides it; exit is tray-only.
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                api.prevent_close();
                let _ = window.hide();
            }
            // The terminal window is hidden too, but its shells close as if it
            // had been destroyed. Tearing the webview down and building a new
            // one on every close/open is what made quick reopening lag (and a
            // reopen racing the teardown could show nothing at all).
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == commands::TERMINAL_WINDOW => {
                api.prevent_close();
                let _ = window.hide();
                let _ = window.emit_to(window.label(), events::TERMINAL_HIDDEN_EVENT, ());
                window.state::<AppState>().terminals.close_all();
                commands::schedule_terminal_teardown(window.app_handle());
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
            commands::add_port_forward,
            commands::update_port_forward,
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
            config_io::export_config,
            config_io::pick_import_file,
            config_io::preview_import,
            config_io::apply_import,
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
