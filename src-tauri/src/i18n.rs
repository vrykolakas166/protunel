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
    /// `{reason}`
    ConnectionLost,
    /// A plain session close: no reason to quote.
    ConnectionLostPlain,
    /// File dialog filter for `.exe` files.
    FilterExecutables,
    /// File dialog filter for protunel config files.
    FilterConfig,
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
        (Lang::En, ConnectionLost) => "Connection lost ({reason}) — reconnecting…",
        (Lang::Vi, ConnectionLost) => "Mất kết nối ({reason}) — đang kết nối lại…",
        (Lang::En, ConnectionLostPlain) => "Connection lost — reconnecting…",
        (Lang::Vi, ConnectionLostPlain) => "Mất kết nối — đang kết nối lại…",
        (Lang::En, FilterExecutables) => "Executables",
        (Lang::Vi, FilterExecutables) => "Tệp thực thi",
        (Lang::En, FilterConfig) => "protunel config",
        (Lang::Vi, FilterConfig) => "Tệp cấu hình protunel",
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

/// The text with its `{reason}` (a server or library message, untranslated) filled in.
pub fn t_reason(app: &AppHandle, text: Text, reason: &str) -> String {
    lookup(lang(app), text).replace("{reason}", reason)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reason_placeholder_survives_translation() {
        for lang in [Lang::En, Lang::Vi] {
            assert!(lookup(lang, Text::ConnectionLost).contains("{reason}"), "{lang:?}");
        }
    }

    #[test]
    fn plain_connection_lost_has_no_placeholder() {
        for lang in [Lang::En, Lang::Vi] {
            let s = lookup(lang, Text::ConnectionLostPlain);
            assert!(!s.contains('{'), "{lang:?}");
            assert!(!s.contains("connection lost") && !s.contains("("), "{lang:?}");
        }
    }

    #[test]
    fn placeholders_survive_translation() {
        for text in [Text::RestartToUpdate, Text::UpdateReadyTitle] {
            for lang in [Lang::En, Lang::Vi] {
                assert!(lookup(lang, text).contains("{version}"), "{lang:?} {text:?}");
            }
        }
    }
}
