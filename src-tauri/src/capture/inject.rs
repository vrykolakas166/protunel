//! Launches a target exe suspended, injects the capture-hook DLL into it
//! before its main thread ever runs, then resumes it. Hand-rolled rather than
//! via a crate: `dll-syringe` requires nightly Rust (confirmed by spike), and
//! this is ~80 lines of well-understood Win32 API against `windows-sys`.

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
use windows_sys::Win32::System::Diagnostics::Debug::WriteProcessMemory;
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
use windows_sys::Win32::System::Memory::{
    VirtualAllocEx, MEM_COMMIT, MEM_RESERVE, PAGE_READWRITE,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, CreateProcessW, CreateRemoteThread, GetExitCodeProcess, OpenProcess,
    QueryFullProcessImageNameW, ResumeThread, TerminateProcess, WaitForSingleObject,
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, INFINITE, PROCESS_INFORMATION,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, STARTUPINFOW,
};

/// The hook DLL reads this in the child process to learn where the router's
/// SOCKS5 port is — the injector doesn't hardcode a port into the DLL binary,
/// since the router's listen port is user-configurable and can change between
/// launches without rebuilding anything.
pub const ROUTER_PORT_ENV_VAR: &str = "PROTUNEL_ROUTER_PORT";

/// A named event both sides can derive independently from the PID (the
/// injector has it from `CreateProcessW`; the hook DLL calls
/// `GetCurrentProcessId()`), so no extra handoff channel is needed. The hook
/// DLL's `DllMain` spawns a thread and returns immediately — required, or it
/// risks deadlocking the loader lock — which means the target's primary
/// thread could otherwise resume and start calling `connect`/`getaddrinfo`
/// while MinHook is still mid-patch on those exact functions: a real
/// self-modifying-code race, reproduced during development as an
/// intermittent hang inside `MinHook::create_hook`. Waiting on this event
/// before `ResumeThread` closes that window.
fn ready_event_name(pid: u32) -> String {
    format!("ProtunelCaptureReady{pid}")
}

pub struct LaunchedProcess {
    pub pid: u32,
}

/// Fails closed: if injection doesn't succeed before the target's main thread
/// starts, the suspended process is killed rather than resumed unhooked.
pub fn launch(
    exe_path: &str,
    args: &[String],
    hook_dll_path: &Path,
    router_port: u16,
) -> Result<LaunchedProcess, String> {
    let mut cmdline = quote_arg(exe_path);
    for arg in args {
        cmdline.push(' ');
        cmdline.push_str(&quote_arg(arg));
    }
    let mut cmdline_w: Vec<u16> = cmdline.encode_utf16().chain(std::iter::once(0)).collect();
    let mut env_block = build_environment_block(router_port);

    let mut startup_info: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup_info.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut process_info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

    let ok = unsafe {
        CreateProcessW(
            std::ptr::null(),
            cmdline_w.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
            env_block.as_mut_ptr() as *mut c_void,
            std::ptr::null(),
            &startup_info,
            &mut process_info,
        )
    };
    if ok == 0 {
        return Err(format!(
            "CreateProcess failed (error {})",
            unsafe { GetLastError() }
        ));
    }

    let ready_event_name: Vec<u16> = ready_event_name(process_info.dwProcessId)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let ready_event = unsafe { CreateEventW(std::ptr::null(), 1, 0, ready_event_name.as_ptr()) };

    if let Err(e) = inject_dll(process_info.hProcess, hook_dll_path) {
        unsafe {
            TerminateProcess(process_info.hProcess, 1);
            CloseHandle(process_info.hThread);
            CloseHandle(process_info.hProcess);
            if !ready_event.is_null() {
                CloseHandle(ready_event);
            }
        }
        return Err(format!("injection failed, process killed before it could run unhooked: {e}"));
    }

    unsafe {
        // Give the hook DLL's setup thread a bounded window to finish
        // installing before letting the target's own code run — see
        // `ready_event_name`'s doc comment. Best-effort: if the event never
        // gets created or signaled (hook DLL crashed mid-install, etc.),
        // still resume after the timeout rather than leaving the launched
        // process stuck forever.
        if !ready_event.is_null() {
            WaitForSingleObject(ready_event, 5000);
            CloseHandle(ready_event);
        }

        ResumeThread(process_info.hThread);
        CloseHandle(process_info.hThread);
        CloseHandle(process_info.hProcess);
    }

    Ok(LaunchedProcess {
        pid: process_info.dwProcessId,
    })
}

/// Classic `LoadLibraryW` injection: write the DLL path into the target's
/// address space, then run `LoadLibraryW(path)` on a remote thread. Blocks
/// until that thread finishes, so the caller knows the hook is installed
/// before resuming the target's real main thread.
fn inject_dll(process: HANDLE, dll_path: &Path) -> Result<(), String> {
    let mut wide: Vec<u16> = dll_path.as_os_str().encode_wide().collect();
    wide.push(0);
    let size = wide.len() * 2;

    unsafe {
        let remote_mem = VirtualAllocEx(
            process,
            std::ptr::null(),
            size,
            MEM_COMMIT | MEM_RESERVE,
            PAGE_READWRITE,
        );
        if remote_mem.is_null() {
            return Err("VirtualAllocEx failed".to_string());
        }

        let mut written = 0usize;
        let ok = WriteProcessMemory(
            process,
            remote_mem,
            wide.as_ptr() as *const c_void,
            size,
            &mut written,
        );
        if ok == 0 {
            return Err("WriteProcessMemory failed".to_string());
        }

        let kernel32 = GetModuleHandleA(b"kernel32.dll\0".as_ptr());
        let Some(load_library_w) = GetProcAddress(kernel32, b"LoadLibraryW\0".as_ptr()) else {
            return Err("GetProcAddress(LoadLibraryW) failed".to_string());
        };

        let thread = CreateRemoteThread(
            process,
            std::ptr::null(),
            0,
            Some(std::mem::transmute::<
                unsafe extern "system" fn() -> isize,
                unsafe extern "system" fn(*mut c_void) -> u32,
            >(load_library_w)),
            remote_mem,
            0,
            std::ptr::null_mut(),
        );
        if thread.is_null() {
            return Err("CreateRemoteThread failed".to_string());
        }

        WaitForSingleObject(thread, INFINITE);
        CloseHandle(thread);
    }

    Ok(())
}

/// No long-lived process handle is kept — a fresh, minimal-rights one is
/// opened per check, matching how Task Manager-style polling works and
/// sidestepping any handle-lifetime bookkeeping across the async runtime.
pub fn is_running(pid: u32) -> bool {
    const STILL_ACTIVE: u32 = 259;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE
    }
}

/// Used by startup crash-recovery to guard against PID reuse: a tracked PID
/// being alive isn't enough on its own, since Windows can hand that same PID
/// to a completely unrelated process after the original one exited — this
/// confirms it's still actually the same executable before treating it as a
/// recovered capture.
pub fn exe_path_of(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut size);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..size as usize]))
    }
}

pub fn terminate(pid: u32) -> Result<(), String> {
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return Err("failed to open process (already exited?)".to_string());
        }
        let ok = TerminateProcess(handle, 1);
        CloseHandle(handle);
        if ok == 0 {
            return Err("TerminateProcess failed".to_string());
        }
    }
    Ok(())
}

/// The child inherits the caller's environment plus `ROUTER_PORT_ENV_VAR` —
/// built explicitly (rather than mutating this process's own env before
/// spawning) so a concurrent launch can't race another one's port value.
/// Win32 wants a UTF-16 block of `KEY=VALUE\0` pairs, double-null-terminated.
fn build_environment_block(router_port: u16) -> Vec<u16> {
    let mut block = String::new();
    for (key, value) in std::env::vars() {
        block.push_str(&key);
        block.push('=');
        block.push_str(&value);
        block.push('\0');
    }
    block.push_str(ROUTER_PORT_ENV_VAR);
    block.push('=');
    block.push_str(&router_port.to_string());
    block.push('\0');
    block.push('\0');
    block.encode_utf16().collect()
}

/// Minimal `CreateProcess` command-line quoting: wrap in quotes if it
/// contains a space, escaping embedded quotes. Good enough for exe paths and
/// simple args — not a full re-implementation of `CommandLineToArgvW` quoting.
fn quote_arg(arg: &str) -> String {
    if arg.is_empty() || arg.contains(' ') || arg.contains('"') {
        format!("\"{}\"", arg.replace('"', "\\\""))
    } else {
        arg.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exercises the real production injection path (not the throwaway spike
    /// rig) against a harmless target. Ignored by default — it launches and
    /// kills a real notepad.exe process and depends on
    /// `resources/capture_hook.dll` having been built
    /// (`node scripts/build-hook-dll.mjs dev`). Run with
    /// `cargo test --lib capture -- --ignored`.
    #[test]
    #[ignore]
    fn launch_injects_and_terminate_kills_it() {
        let hook_dll = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/capture_hook.dll");
        assert!(
            hook_dll.exists(),
            "run `node scripts/build-hook-dll.mjs dev` first"
        );

        let log_path = std::env::temp_dir().join("protunel_capture_hook.log");
        let _ = std::fs::remove_file(&log_path);

        let launched = launch("C:\\Windows\\System32\\notepad.exe", &[], &hook_dll, 1090)
            .expect("launch should succeed");
        assert!(launched.pid > 0);
        assert!(is_running(launched.pid));

        // The hook DLL installs 5 hooks from a background thread — wait for
        // its own "all hooks installed" completion marker, not just the
        // first "loaded" line, or this races ahead of the real work and
        // terminate() kills the process mid-install.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut contents = String::new();
        while std::time::Instant::now() < deadline {
            contents = std::fs::read_to_string(&log_path).unwrap_or_default();
            if contents.contains("all hooks installed") || contents.contains("PANIC") {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        terminate(launched.pid).expect("terminate should succeed");
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!is_running(launched.pid), "process should be dead after terminate");
        assert!(!contents.contains("PANIC"), "hook install panicked:\n{contents}");
        for hook in [
            "connect",
            "WSAConnect",
            "getaddrinfo",
            "GetAddrInfoW",
            "WSAIoctl",
            "CreateIoCompletionPort",
            "ioctlsocket",
            "closesocket",
        ] {
            assert!(
                contents.contains(&format!("{hook}: hook enabled")),
                "{hook} hook never confirmed enabled:\n{contents}"
            );
        }
    }

    /// End-to-end proof that the redirect actually works, not just installs:
    /// launches real `curl.exe` against a minimal fake SOCKS5 server standing
    /// in for the router, and confirms (a) curl's own `connect()` succeeded
    /// through it and (b) the server received a domain-ATYP CONNECT request
    /// for the real hostname curl asked for — proving the `getaddrinfo` hook
    /// preserved it rather than degrading to a raw-IP request. Ignored by
    /// default for the same reasons as the test above.
    #[test]
    #[ignore]
    fn connect_redirects_through_fake_router_with_hostname_preserved() {
        let hook_dll = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/capture_hook.dll");
        assert!(hook_dll.exists(), "run `node scripts/build-hook-dll.mjs dev` first");

        let log_path = std::env::temp_dir().join("protunel_capture_hook.log");
        let _ = std::fs::remove_file(&log_path);

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind fake router");
        let router_port = listener.local_addr().unwrap().port();

        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            tx.send(fake_socks5_server_accept_one(listener)).ok();
        });

        let launched = launch(
            "C:\\Windows\\System32\\curl.exe",
            &[
                "--max-time".into(),
                "3".into(),
                "-s".into(),
                "-o".into(),
                "NUL".into(),
                "http://example.com/".into(),
            ],
            &hook_dll,
            router_port,
        )
        .expect("launch should succeed");

        let seen = rx
            .recv_timeout(std::time::Duration::from_secs(8))
            .expect("fake router never received a CONNECT request — hook did not redirect");

        std::thread::sleep(std::time::Duration::from_millis(500));
        let _ = terminate(launched.pid);

        assert_eq!(
            seen,
            "example.com:80",
            "expected domain-ATYP request for the real hostname, got {seen}"
        );
    }

    /// The fiddliest piece of the whole plan: proves `ConnectEx`'s fake IOCP
    /// completion actually wakes up a real async event loop rather than
    /// hanging it forever. Node's `net.connect` on Windows goes through
    /// libuv, which uses `ConnectEx` via the exact
    /// `WSAIoctl`/`SIO_GET_EXTENSION_FUNCTION_POINTER` indirection this hook
    /// intercepts — if the fake completion posting were wrong, Node's
    /// callback would simply never fire and this test would see "TIMEOUT",
    /// not a crash, which is exactly the failure mode worth guarding against.
    #[test]
    #[ignore]
    fn connectex_redirects_through_fake_router_hostname_preserved() {
        let hook_dll = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/capture_hook.dll");
        assert!(hook_dll.exists(), "run `node scripts/build-hook-dll.mjs dev` first");

        let result_path = std::env::temp_dir().join("protunel_test_node_connect_result.txt");
        let _ = std::fs::remove_file(&result_path);
        let log_path = std::env::temp_dir().join("protunel_capture_hook.log");
        let _ = std::fs::remove_file(&log_path);

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind fake router");
        let router_port = listener.local_addr().unwrap().port();

        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            tx.send(fake_socks5_server_accept_one(listener)).ok();
        });

        let out = result_path.to_string_lossy().replace('\\', "\\\\");
        let script = format!(
            "const net=require('net');const fs=require('fs');\
             const out='{out}';\
             const s=net.connect({{host:'example.com',port:80}},()=>{{fs.writeFileSync(out,'CONNECTED');process.exit(0);}});\
             s.on('error',e=>{{fs.writeFileSync(out,'ERROR:'+e.message);process.exit(1);}});\
             setTimeout(()=>{{fs.writeFileSync(out,'TIMEOUT');process.exit(2);}},5000);"
        );

        let launched = launch(
            "C:\\Program Files\\nodejs\\node.exe",
            &["-e".to_string(), script],
            &hook_dll,
            router_port,
        )
        .expect("launch should succeed");

        let seen = rx
            .recv_timeout(std::time::Duration::from_secs(8))
            .expect("fake router never received a CONNECT request — ConnectEx did not redirect");

        // Give Node's callback a moment to run and write the result file
        // after the fake router already replied success.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut result = String::new();
        while std::time::Instant::now() < deadline {
            if let Ok(contents) = std::fs::read_to_string(&result_path) {
                result = contents;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        let _ = terminate(launched.pid);

        assert_eq!(seen, "example.com:80", "expected domain-ATYP request for the real hostname");
        assert_eq!(
            result, "CONNECTED",
            "Node's connect callback didn't fire with success — fake IOCP completion likely didn't wake the event loop. hook log:\n{}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
    }

    /// Diagnostic, not a regression test: launches the real RedisInsight.exe
    /// (if installed locally) against a real multi-connection relay server
    /// standing in for the router (does an actual `Direct`-style dial-out
    /// per connection, not just a canned reply), and dumps the full hook log
    /// either way so a failure is diagnosable from the panic message alone.
    /// Skips itself (doesn't fail) if RedisInsight isn't installed here.
    #[test]
    #[ignore]
    fn redisinsight_smoke_test() {
        let redisinsight = std::path::Path::new(
            "C:\\Users\\Admin\\AppData\\Local\\Programs\\Redis Insight\\Redis Insight.exe",
        );
        if !redisinsight.exists() {
            eprintln!("RedisInsight not installed here, skipping");
            return;
        }
        let hook_dll = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/capture_hook.dll");
        assert!(hook_dll.exists(), "run `node scripts/build-hook-dll.mjs dev` first");

        let log_path = std::env::temp_dir().join("protunel_capture_hook.log");
        let _ = std::fs::remove_file(&log_path);

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind relay");
        let router_port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || run_relay_server(listener, false));

        let launched = launch(redisinsight.to_str().unwrap(), &[], &hook_dll, router_port)
            .expect("launch should succeed");

        eprintln!("REDISINSIGHT_PID={}", launched.pid);

        // Give it real time to get through startup networking (Sentry,
        // update check, etc.) and either open its window or crash.
        std::thread::sleep(std::time::Duration::from_secs(60));
        let still_running = is_running(launched.pid);

        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        let _ = terminate(launched.pid);

        assert!(
            still_running,
            "RedisInsight exited before the smoke-test window elapsed — hook log:\n{log}"
        );
        assert!(!log.contains("PANIC"), "hook install panicked:\n{log}");
    }

    /// Real `Direct`-style relay: SOCKS5-handshakes each accepted connection,
    /// then actually dials the requested target for real and pipes bytes
    /// both ways — closer to real router behavior than the single-shot fake
    /// server below, and handles however many concurrent connections a real
    /// app opens instead of just one.
    fn run_relay_server(listener: std::net::TcpListener, instant: bool) {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            std::thread::spawn(move || {
                let _ = if instant {
                    relay_one_instant(stream)
                } else {
                    relay_one(stream)
                };
            });
        }
    }

    /// Replies SOCKS5 success immediately, no real dial-out — isolates
    /// "our own redirect overhead" from "real network latency to the actual
    /// target" for timing-related crash theories. Subsequent app-level
    /// traffic (e.g. TLS) is read and discarded rather than forwarded, since
    /// there's nothing real on the other end.
    fn relay_one_instant(mut stream: std::net::TcpStream) -> std::io::Result<()> {
        use std::io::{Read, Write};

        let mut greeting = [0u8; 3];
        stream.read_exact(&mut greeting)?;
        stream.write_all(&[0x05, 0x00])?;

        let mut header = [0u8; 4];
        stream.read_exact(&mut header)?;
        match header[3] {
            0x01 => {
                let mut ip = [0u8; 4];
                stream.read_exact(&mut ip)?;
            }
            0x03 => {
                let mut len_byte = [0u8; 1];
                stream.read_exact(&mut len_byte)?;
                let mut name = vec![0u8; len_byte[0] as usize];
                stream.read_exact(&mut name)?;
            }
            _ => return Ok(()),
        };
        let mut port_bytes = [0u8; 2];
        stream.read_exact(&mut port_bytes)?;

        stream.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])?;

        let mut sink = std::io::sink();
        let _ = std::io::copy(&mut stream, &mut sink);
        Ok(())
    }

    fn relay_one(mut stream: std::net::TcpStream) -> std::io::Result<()> {
        use std::io::{Read, Write};

        let mut greeting = [0u8; 3];
        stream.read_exact(&mut greeting)?;
        stream.write_all(&[0x05, 0x00])?;

        let mut header = [0u8; 4];
        stream.read_exact(&mut header)?;
        let target = match header[3] {
            0x01 => {
                let mut ip = [0u8; 4];
                stream.read_exact(&mut ip)?;
                format!("{}.{}.{}.{}", ip[0], ip[1], ip[2], ip[3])
            }
            0x03 => {
                let mut len_byte = [0u8; 1];
                stream.read_exact(&mut len_byte)?;
                let mut name = vec![0u8; len_byte[0] as usize];
                stream.read_exact(&mut name)?;
                String::from_utf8_lossy(&name).to_string()
            }
            _ => return Ok(()),
        };
        let mut port_bytes = [0u8; 2];
        stream.read_exact(&mut port_bytes)?;
        let port = u16::from_be_bytes(port_bytes);

        let remote = match std::net::TcpStream::connect((target.as_str(), port)) {
            Ok(r) => r,
            Err(_) => {
                let _ = stream.write_all(&[0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
                return Ok(());
            }
        };
        stream.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])?;

        let mut client_read = stream.try_clone()?;
        let mut remote_write = remote.try_clone()?;
        let mut remote_read = remote;
        let mut client_write = stream;
        let up = std::thread::spawn(move || {
            let _ = std::io::copy(&mut client_read, &mut remote_write);
        });
        let _ = std::io::copy(&mut remote_read, &mut client_write);
        let _ = up.join();
        Ok(())
    }

    /// Minimal one-shot SOCKS5 server: no-auth greeting, then parses exactly
    /// one CONNECT request and replies success, returning "<host>:<port>" (or
    /// "<ip>:<port>" for IPv4-ATYP) as seen on the wire.
    fn fake_socks5_server_accept_one(listener: std::net::TcpListener) -> String {
        use std::io::{Read, Write};

        let (mut stream, _) = listener.accept().expect("accept");

        let mut greeting = [0u8; 3];
        stream.read_exact(&mut greeting).expect("read greeting");
        stream.write_all(&[0x05, 0x00]).expect("write greeting reply");

        let mut header = [0u8; 4];
        stream.read_exact(&mut header).expect("read request header");
        let target = match header[3] {
            0x01 => {
                let mut ip = [0u8; 4];
                stream.read_exact(&mut ip).expect("read ipv4");
                format!("{}.{}.{}.{}", ip[0], ip[1], ip[2], ip[3])
            }
            0x03 => {
                let mut len_byte = [0u8; 1];
                stream.read_exact(&mut len_byte).expect("read domain len");
                let mut name = vec![0u8; len_byte[0] as usize];
                stream.read_exact(&mut name).expect("read domain");
                String::from_utf8(name).expect("domain utf8")
            }
            other => panic!("unexpected ATYP {other}"),
        };
        let mut port_bytes = [0u8; 2];
        stream.read_exact(&mut port_bytes).expect("read port");
        let port = u16::from_be_bytes(port_bytes);

        stream
            .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .expect("write connect reply");

        format!("{target}:{port}")
    }
}
