//! Text Rust shows by itself — the tray menu and desktop notifications — in
//! the language the user picked (`settings.language`). Everything the window
//! draws stays in `src/locales`; only strings that never pass through the
//! webview live here. A new UI language means a new arm in `lookup`.

use tauri::{AppHandle, Manager};

use crate::tunnel::AppState;

#[derive(Clone, Copy, Debug)]
pub enum Text {
    ShowHide,
    InternalNetwork,
    /// `{version}`
    RestartToUpdate,
    Exit,
    Connected,
    Disconnected,
    ConnectionError,
    /// `{version}`
    UpdateReadyTitle,
    UpdateReadyBody,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Lang {
    En,
    Vi,
}

fn lang(app: &AppHandle) -> Lang {
    let language = app
        .try_state::<AppState>()
        .map(|s| s.settings.get().language)
        .unwrap_or_default();
    if language.starts_with("vi") {
        Lang::Vi
    } else {
        Lang::En
    }
}

fn lookup(lang: Lang, text: Text) -> &'static str {
    use Text::*;
    match (lang, text) {
        (Lang::En, ShowHide) => "Show/Hide",
        (Lang::Vi, ShowHide) => "Hiện/Ẩn",
        (Lang::En, InternalNetwork) => "Internal network",
        (Lang::Vi, InternalNetwork) => "Mạng nội bộ",
        (Lang::En, RestartToUpdate) => "Restart to update to {version}",
        (Lang::Vi, RestartToUpdate) => "Khởi động lại để cập nhật lên {version}",
        (Lang::En, Exit) => "Exit",
        (Lang::Vi, Exit) => "Thoát",
        (Lang::En, Connected) => "Connected",
        (Lang::Vi, Connected) => "Đã kết nối",
        (Lang::En, Disconnected) => "Disconnected",
        (Lang::Vi, Disconnected) => "Đã ngắt kết nối",
        (Lang::En, ConnectionError) => "Connection error",
        (Lang::Vi, ConnectionError) => "Lỗi kết nối",
        (Lang::En, UpdateReadyTitle) => "protunel {version} is ready",
        (Lang::Vi, UpdateReadyTitle) => "protunel {version} đã sẵn sàng",
        (Lang::En, UpdateReadyBody) => "Restart protunel to finish updating.",
        (Lang::Vi, UpdateReadyBody) => "Khởi động lại protunel để hoàn tất cập nhật.",
    }
}

/// The text in the user's language.
pub fn t(app: &AppHandle, text: Text) -> String {
    lookup(lang(app), text).to_string()
}

/// The text with its `{version}` filled in.
pub fn t_version(app: &AppHandle, text: Text, version: &str) -> String {
    lookup(lang(app), text).replace("{version}", version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_survive_translation() {
        for text in [Text::RestartToUpdate, Text::UpdateReadyTitle] {
            for lang in [Lang::En, Lang::Vi] {
                assert!(lookup(lang, text).contains("{version}"), "{lang:?} {text:?}");
            }
        }
    }
}
