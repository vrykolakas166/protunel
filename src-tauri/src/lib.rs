mod commands;
mod db;
mod events;
mod secrets;
mod settings;
mod ssh;
mod tray;
mod tunnel;

use tauri::Manager;
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

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db = db::Db::open(&data_dir.join("protunel.db"))?;
            app.manage(AppState::new(&data_dir, db));
            tray::setup(app.handle())?;
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
