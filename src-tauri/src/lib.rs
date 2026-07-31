mod commands;
mod db;
mod events;
mod secrets;
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
            commands::connect_tunnel,
            commands::disconnect_tunnel,
            commands::confirm_host_key,
            commands::reject_host_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
