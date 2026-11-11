//! Smooth window resize for popups that need more room (see `src/windowFit.ts`).
//!
//! Native windows have no animated resize. Stepping it from the webview costs
//! two IPC round trips per frame (size, then position) and the window visibly
//! shows the halfway states between them. This steps it here instead, moving
//! and sizing in one `SetWindowPos` call per frame.

use std::time::{Duration, Instant};

use tauri::WebviewWindow;

/// About one display frame at 120 Hz; Windows' timer granularity makes this
/// land nearer 60 Hz on default settings, which is still smooth.
const FRAME: Duration = Duration::from_millis(8);

fn ease_out_cubic(t: f64) -> f64 {
    1.0 - (1.0 - t).powi(3)
}

/// Animates the calling window to an inner size of `width`×`height` with its
/// outer top-left at (`x`, `y`), all in logical pixels, over `duration_ms`.
#[tauri::command]
pub async fn animate_window(
    window: WebviewWindow,
    width: f64,
    height: f64,
    x: f64,
    y: f64,
    duration_ms: u64,
) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let inner = window.inner_size().map_err(|e| e.to_string())?;
    let outer = window.outer_size().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    // Title bar and borders, which SetWindowPos sizes along with the content.
    let chrome_w = outer.width as f64 - inner.width as f64;
    let chrome_h = outer.height as f64 - inner.height as f64;

    let from = [pos.x as f64, pos.y as f64, outer.width as f64, outer.height as f64];
    let to = [
        x * scale,
        y * scale,
        width * scale + chrome_w,
        height * scale + chrome_h,
    ];
    let duration = Duration::from_millis(duration_ms.max(1));

    tauri::async_runtime::spawn_blocking(move || {
        let start = Instant::now();
        loop {
            let t = (start.elapsed().as_secs_f64() / duration.as_secs_f64()).min(1.0);
            let k = ease_out_cubic(t);
            let at = |i: usize| (from[i] + (to[i] - from[i]) * k).round() as i32;
            place(&window, at(0), at(1), at(2), at(3));
            if t >= 1.0 {
                break;
            }
            std::thread::sleep(FRAME);
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn place(window: &WebviewWindow, x: i32, y: i32, w: i32, h: i32) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};
    let Ok(hwnd) = window.hwnd() else { return };
    // SAFETY: a live window handle owned by this process; position and size are
    // plain integers, and the flags leave z-order and activation untouched.
    unsafe {
        SetWindowPos(hwnd.0 as _, std::ptr::null_mut(), x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
    }
}

#[cfg(not(windows))]
fn place(window: &WebviewWindow, x: i32, y: i32, w: i32, h: i32) {
    use tauri::{PhysicalPosition, PhysicalSize};
    let _ = window.set_position(PhysicalPosition::new(x, y));
    let _ = window.set_size(PhysicalSize::new(w as u32, h as u32));
}
