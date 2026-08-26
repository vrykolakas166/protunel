mod hooks;
mod hostnames;
mod socks5;

use std::ffi::c_void;
use std::fs::OpenOptions;
use std::io::Write;

use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::System::SystemServices::DLL_PROCESS_ATTACH;
use windows_sys::Win32::System::Threading::{CreateEventW, CreateThread, GetCurrentProcessId, SetEvent};

/// Matches `capture::inject::ROUTER_PORT_ENV_VAR` in the main app crate —
/// duplicated rather than shared, since this cdylib is a separate crate with
/// its own dependency graph (see CLAUDE.md: it's never linked into the app).
const ROUTER_PORT_ENV_VAR: &str = "PROTUNEL_ROUTER_PORT";

fn log(msg: &str) {
    if let Ok(mut f) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("protunel_capture_hook.log"))
    {
        let _ = writeln!(f, "capture-hook: {msg}");
    }
}

unsafe extern "system" fn setup_thread(_param: *mut c_void) -> u32 {
    log("loaded");
    // Raw `CreateThread`, not `std::thread::spawn` — a panic unwinding out of
    // this `extern "system"` fn would be UB, so catch it explicitly and log
    // it rather than let it vanish silently or take the process down.
    let result = std::panic::catch_unwind(|| {
        hooks::install();
    });
    if let Err(e) = result {
        let msg = e
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| e.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "(non-string panic payload)".to_string());
        log(&format!("PANIC in hooks::install(): {msg}"));
    }
    signal_ready();
    0
}

/// Tells the injector (waiting in `capture::inject::launch`) that it's safe
/// to resume the target's primary thread — called unconditionally, success
/// or panic, so a failure here never leaves the launcher hanging on its
/// 5-second timeout for no reason.
fn signal_ready() {
    let pid = unsafe { GetCurrentProcessId() };
    let name: Vec<u16> = format!("ProtunelCaptureReady{pid}")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let handle = CreateEventW(std::ptr::null(), 1, 0, name.as_ptr());
        if !handle.is_null() {
            SetEvent(handle);
            CloseHandle(handle);
        }
    }
}

#[no_mangle]
#[allow(non_snake_case)]
pub extern "system" fn DllMain(_hinst: *mut c_void, reason: u32, _reserved: *mut c_void) -> i32 {
    if reason == DLL_PROCESS_ATTACH {
        unsafe {
            CreateThread(
                std::ptr::null(),
                0,
                Some(setup_thread),
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
            );
        }
    }
    1
}
