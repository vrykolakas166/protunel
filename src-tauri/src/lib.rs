mod capture;
mod commands;
mod config_io;
mod db;
mod events;
mod network;
mod router;
mod secrets;
mod settings;
mod ssh;
mod tray;
mod tunnel;

use tauri::{Manager, RunEvent};
pub use tunnel::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            None,
        ))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db = db::Db::open(&data_dir.join("protunel.db"))?;
            app.manage(AppState::new(&data_dir, db));
            tray::setup(app.handle())?;

            // Undo a system proxy left behind by a previous run that was killed
            // before it could clean up. Must happen before the router starts, or
            // recovery would restore over our own fresh settings.
            router::system_proxy::recover(app.handle());

            let state = app.state::<AppState>();
            let _ = state.router.reload_rules(&state.db);
            if state.router.config().enabled {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = router::start(&handle).await {
                        router::emit_status(
                            &handle,
                            events::RouterStatus::Error,
                            None,
                            Some(e),
                        );
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_tunnels,
            commands::list_tunnel_statuses,
            commands::add_tunnel,
            commands::update_tunnel,
            commands::delete_tunnel,
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
            commands::get_settings,
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
            config_io::export_config,
            config_io::pick_import_file,
            config_io::preview_import,
            config_io::apply_import,
            network::list_local_ips,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|app_handle, event| {
        // Tray "Exit" calls app.exit(0), which lands here. This is the only
        // clean-shutdown hook, and the system proxy must not outlive the app.
        if let RunEvent::Exit = event {
            router::system_proxy::cleanup_on_exit(app_handle);
        }
    });
}
