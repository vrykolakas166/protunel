//! Installs the Winsock hooks and implements the redirect-through-router
//! logic shared by all three connect entry points a Windows app might use:
//! `connect`/`WSAConnect` (synchronous callers) and `ConnectEx` (IOCP-based
//! async callers, reached indirectly via `WSAIoctl`'s
//! `SIO_GET_EXTENSION_FUNCTION_POINTER` — `ConnectEx` isn't a normal export,
//! apps fetch a function pointer to it at runtime).

use std::collections::HashMap;
use std::ffi::{c_void, CStr};
use std::net::Ipv4Addr;
use std::sync::{Mutex, OnceLock};

use minhook::MinHook;
use windows_sys::core::GUID;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Networking::WinSock::{
    closesocket, connect, getaddrinfo, ioctlsocket, setsockopt, GetAddrInfoW, WSAConnect,
    WSAIoctl, WSASetLastError, ADDRINFOA, ADDRINFOW, AF_INET, FIONBIO, SOCKADDR, SOCKADDR_IN,
    SOCKET, SOL_SOCKET, SO_RCVTIMEO, SO_SNDTIMEO, SO_UPDATE_CONNECT_CONTEXT, WSAECONNREFUSED,
    WSA_IO_PENDING,
};
use windows_sys::Win32::System::IO::{CreateIoCompletionPort, OVERLAPPED};

use crate::{hostnames, log, socks5};
use crate::socks5::Destination;

/// Worst-case time our own redirect (dial the router + SOCKS5 handshake,
/// which for the real router means dialing the real destination, possibly
/// over a slow tunnel) is allowed to take. See `redirect_and_handshake`'s
/// doc comment for why this exists.
const REDIRECT_TIMEOUT_MS: u32 = 5000;

const SIO_GET_EXTENSION_FUNCTION_POINTER: u32 = 0xC800_0006;
const WSAID_CONNECTEX: GUID = GUID {
    data1: 0x25a207b9,
    data2: 0xddf3,
    data3: 0x4660,
    data4: [0x8e, 0xe9, 0x76, 0xe5, 0x8c, 0x74, 0x06, 0x3e],
};

type ConnectFn = unsafe extern "system" fn(SOCKET, *const SOCKADDR, i32) -> i32;
type WsaConnectFn = unsafe extern "system" fn(
    SOCKET,
    *const SOCKADDR,
    i32,
    *mut c_void,
    *mut c_void,
    *const c_void,
    *const c_void,
) -> i32;
type GetAddrInfoFn =
    unsafe extern "system" fn(*const u8, *const u8, *const ADDRINFOA, *mut *mut ADDRINFOA) -> i32;
type GetAddrInfoWFn = unsafe extern "system" fn(
    *const u16,
    *const u16,
    *const ADDRINFOW,
    *mut *mut ADDRINFOW,
) -> i32;
type WsaIoctlFn = unsafe extern "system" fn(
    SOCKET,
    u32,
    *const c_void,
    u32,
    *mut c_void,
    u32,
    *mut u32,
    *mut OVERLAPPED,
    *mut c_void,
) -> i32;
type CreateIoCompletionPortFn =
    unsafe extern "system" fn(HANDLE, HANDLE, usize, u32) -> HANDLE;
type IoctlSocketFn = unsafe extern "system" fn(SOCKET, i32, *mut u32) -> i32;
type CloseSocketFn = unsafe extern "system" fn(SOCKET) -> i32;
type ConnectExFn = unsafe extern "system" fn(
    SOCKET,
    *const SOCKADDR,
    i32,
    *mut c_void,
    u32,
    *mut u32,
    *mut OVERLAPPED,
) -> i32;

static ORIGINAL_CONNECT: OnceLock<usize> = OnceLock::new();
static ORIGINAL_WSACONNECT: OnceLock<usize> = OnceLock::new();
static ORIGINAL_GETADDRINFO: OnceLock<usize> = OnceLock::new();
static ORIGINAL_GETADDRINFOW: OnceLock<usize> = OnceLock::new();
static ORIGINAL_WSAIOCTL: OnceLock<usize> = OnceLock::new();
static ORIGINAL_CREATE_IO_COMPLETION_PORT: OnceLock<usize> = OnceLock::new();
static ORIGINAL_IOCTLSOCKET: OnceLock<usize> = OnceLock::new();
static ORIGINAL_CLOSESOCKET: OnceLock<usize> = OnceLock::new();
static ROUTER_PORT: OnceLock<u16> = OnceLock::new();

/// Sockets the app has explicitly set non-blocking via `ioctlsocket`
/// (`FIONBIO`), observed as they're set. Absent from this map means blocking
/// — the OS default for a freshly created socket, and the common case for
/// the simple synchronous clients this hook set covers.
static NONBLOCKING_SOCKETS: OnceLock<Mutex<HashMap<usize, bool>>> = OnceLock::new();

fn nonblocking_sockets() -> &'static Mutex<HashMap<usize, bool>> {
    NONBLOCKING_SOCKETS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Tracks which completion port (and completion key) a socket was associated
/// with via `CreateIoCompletionPort`, so a redirected `ConnectEx` can post a
/// real completion packet to the same place the app's own event loop is
/// waiting on — without this, an IOCP-based app (Node, .NET, Go) would hang
/// forever waiting for a completion notification that never arrives.
/// Values are `(iocp_handle as isize, completion_key)` — `HANDLE` itself
/// (`*mut c_void`) isn't `Send`/`Sync`, but it's an opaque OS handle value
/// with no aliasing/lifetime meaning to Rust, so storing it as `isize` and
/// casting back at the point of use is sound.
static IOCP_ASSOCIATIONS: OnceLock<Mutex<HashMap<isize, (isize, usize)>>> = OnceLock::new();

fn iocp_associations() -> &'static Mutex<HashMap<isize, (isize, usize)>> {
    IOCP_ASSOCIATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Reads the router port the injector passed via the environment and
/// installs every hook. Logs and does nothing else if the port is missing —
/// that means this DLL was loaded some other way than protunel's own
/// injector, and there is nothing safe to redirect traffic to.
pub fn install() {
    let Ok(port_str) = std::env::var(crate::ROUTER_PORT_ENV_VAR) else {
        log("no router port in environment, hooks not installed");
        return;
    };
    let Ok(port) = port_str.parse::<u16>() else {
        log(&format!("invalid router port env value: {port_str}"));
        return;
    };
    let _ = ROUTER_PORT.set(port);
    log(&format!("router port = {port}"));

    unsafe {
        install_hook(
            "connect",
            connect as *mut c_void,
            detour_connect as *mut c_void,
            &ORIGINAL_CONNECT,
        );
        install_hook(
            "WSAConnect",
            WSAConnect as *mut c_void,
            detour_wsaconnect as *mut c_void,
            &ORIGINAL_WSACONNECT,
        );
        install_hook(
            "getaddrinfo",
            getaddrinfo as *mut c_void,
            detour_getaddrinfo as *mut c_void,
            &ORIGINAL_GETADDRINFO,
        );
        install_hook(
            "GetAddrInfoW",
            GetAddrInfoW as *mut c_void,
            detour_getaddrinfo_w as *mut c_void,
            &ORIGINAL_GETADDRINFOW,
        );
        install_hook(
            "WSAIoctl",
            WSAIoctl as *mut c_void,
            detour_wsaioctl as *mut c_void,
            &ORIGINAL_WSAIOCTL,
        );
        install_hook(
            "CreateIoCompletionPort",
            CreateIoCompletionPort as *mut c_void,
            detour_create_io_completion_port as *mut c_void,
            &ORIGINAL_CREATE_IO_COMPLETION_PORT,
        );
        install_hook(
            "ioctlsocket",
            ioctlsocket as *mut c_void,
            detour_ioctlsocket as *mut c_void,
            &ORIGINAL_IOCTLSOCKET,
        );
        install_hook(
            "closesocket",
            closesocket as *mut c_void,
            detour_closesocket as *mut c_void,
            &ORIGINAL_CLOSESOCKET,
        );
    }
    log("all hooks installed");
}

unsafe fn install_hook(name: &str, target: *mut c_void, detour: *mut c_void, slot: &OnceLock<usize>) {
    log(&format!("{name}: about to create_hook (target={target:?}, detour={detour:?})"));
    match MinHook::create_hook(target, detour) {
        Ok(original) => {
            let _ = slot.set(original as usize);
            match MinHook::enable_hook(target) {
                Ok(_) => log(&format!("{name}: hook enabled")),
                Err(e) => log(&format!("{name}: enable failed: {e:?}")),
            }
        }
        Err(e) => log(&format!("{name}: create_hook failed: {e:?}")),
    }
}

/// Builds a `Destination` from a raw `sockaddr` if we understand it (IPv4
/// only in v1). `None` means "don't intercept this one" — IPv6 and anything
/// else passes straight through to the real function unmodified, rather than
/// being fail-closed-blocked; fail-closed is reserved for the case where we
/// *did* commit to redirecting and the router turned out to be unreachable.
unsafe fn destination_from_sockaddr(addr: *const SOCKADDR, len: i32) -> Option<Destination> {
    if addr.is_null() || (*addr).sa_family != AF_INET as u16 {
        return None;
    }
    if (len as usize) < std::mem::size_of::<SOCKADDR_IN>() {
        return None;
    }
    let addr_in = &*(addr as *const SOCKADDR_IN);
    let raw = addr_in.sin_addr.S_un.S_addr.to_ne_bytes();
    let ip = Ipv4Addr::new(raw[0], raw[1], raw[2], raw[3]);
    let port = u16::from_be(addr_in.sin_port);

    // Loopback destinations are never meant to leave the machine — Windows
    // itself uses local connect()s for things like DNS-client-service
    // plumbing, which is easy to trip over once a hook is process-wide.
    // Redirecting those through the router is both pointless and, for
    // anything OS-internal, actively harmful. Pass them through untouched.
    if ip.is_loopback() {
        return None;
    }

    Some(match hostnames::lookup(ip) {
        Some(host) => Destination::Domain(host, port),
        None => Destination::Ip(ip, port),
    })
}

fn guid_eq(a: &GUID, b: &GUID) -> bool {
    a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
}

fn loopback_sockaddr(port: u16) -> SOCKADDR_IN {
    let mut addr: SOCKADDR_IN = unsafe { std::mem::zeroed() };
    addr.sin_family = AF_INET as u16;
    addr.sin_port = port.to_be();
    addr.sin_addr.S_un.S_addr = u32::from_ne_bytes([127, 0, 0, 1]);
    addr
}

/// Forces `s` into blocking mode via the real `ioctlsocket`, so our own
/// connect-to-router + SOCKS5 handshake can use plain blocking send/recv
/// regardless of whatever mode the app's own code set. Idempotent to call
/// with `false` even if the socket was already blocking.
unsafe fn set_blocking(s: SOCKET, blocking: bool) {
    let Some(&original) = ORIGINAL_IOCTLSOCKET.get() else {
        return;
    };
    let real: IoctlSocketFn = std::mem::transmute(original);
    let mut mode: u32 = if blocking { 0 } else { 1 };
    real(s, FIONBIO, &mut mode);
}

/// Windows reuses socket handle *values* once closed — without this cleanup,
/// `iocp_associations`/`nonblocking_sockets` could hold a stale entry for a
/// value later reused by an unrelated socket, and `detour_connect_ex` would
/// post a bogus completion to whatever IOCP/key the *old* connection happened
/// to be associated with. Removed before the real close, not after, so the
/// entry is gone before the value can become reusable.
unsafe extern "system" fn detour_closesocket(s: SOCKET) -> i32 {
    iocp_associations().lock().unwrap().remove(&(s as isize));
    nonblocking_sockets().lock().unwrap().remove(&(s as usize));

    let original = ORIGINAL_CLOSESOCKET.get().copied().unwrap();
    let real: CloseSocketFn = std::mem::transmute(original);
    real(s)
}

unsafe extern "system" fn detour_ioctlsocket(s: SOCKET, cmd: i32, argp: *mut u32) -> i32 {
    let original = ORIGINAL_IOCTLSOCKET.get().copied().unwrap();
    let real: IoctlSocketFn = std::mem::transmute(original);
    let rc = real(s, cmd, argp);
    if rc == 0 && cmd == FIONBIO && !argp.is_null() {
        nonblocking_sockets()
            .lock()
            .unwrap()
            .insert(s as usize, *argp != 0);
    }
    rc
}

/// Redirects `s` (already created by the caller, not yet connected) to the
/// router and completes the SOCKS5 handshake for `dest`. `false` means
/// fail-closed: the caller must report failure, never fall back to dialing
/// `dest` directly.
///
/// Temporarily forces the socket to blocking mode for the duration — most
/// real clients (curl, browsers, anything async) set `FIONBIO` non-blocking
/// before calling `connect`, and a non-blocking `connect()` to the router
/// would return `WSAEWOULDBLOCK` immediately instead of actually completing,
/// which looked exactly like a hard failure before this fix existed. The
/// original mode is restored before returning either way, so the app's own
/// subsequent I/O on this now-connected socket behaves exactly as it expects.
unsafe fn redirect_and_handshake(s: SOCKET, dest: &Destination) -> bool {
    let Some(&port) = ROUTER_PORT.get() else {
        log("redirect: no router port known, cannot redirect");
        return false;
    };
    let Some(&original) = ORIGINAL_CONNECT.get() else {
        log("redirect: no original connect() trampoline, cannot redirect");
        return false;
    };
    let real_connect: ConnectFn = std::mem::transmute(original);

    let was_nonblocking = nonblocking_sockets()
        .lock()
        .unwrap()
        .get(&(s as usize))
        .copied()
        .unwrap_or(false);
    log(&format!("redirect: socket={s} was_nonblocking={was_nonblocking}"));
    if was_nonblocking {
        set_blocking(s, true);
    }

    let loopback = loopback_sockaddr(port);
    let rc = real_connect(
        s,
        &loopback as *const SOCKADDR_IN as *const SOCKADDR,
        std::mem::size_of::<SOCKADDR_IN>() as i32,
    );
    let ok = if rc != 0 {
        let err = windows_sys::Win32::Networking::WinSock::WSAGetLastError();
        log(&format!("redirect: socket={s} connect to router failed, WSAGetLastError={err}"));
        false
    } else {
        // Bounds how long the router (dialing the real destination, possibly
        // over a slow tunnel) can make us wait. We have no way to safely
        // cancel a pending redirect once the app has moved on and freed
        // whatever request object it was tracking for this connect — a real
        // crash was root-caused to exactly that: our ConnectEx path taking
        // too long let libuv time the attempt out and free its request
        // before our completion arrived, so we later wrote into freed
        // memory. Keeping our own worst case short sharply cuts how often
        // that race is even reachable. Restored to no-timeout below
        // regardless of outcome, so the app's own use of this socket
        // afterward isn't affected by a setting it never asked for.
        let timeout_ms: u32 = REDIRECT_TIMEOUT_MS;
        setsockopt(
            s,
            SOL_SOCKET as i32,
            SO_RCVTIMEO,
            &timeout_ms as *const u32 as *const u8,
            std::mem::size_of::<u32>() as i32,
        );
        setsockopt(
            s,
            SOL_SOCKET as i32,
            SO_SNDTIMEO,
            &timeout_ms as *const u32 as *const u8,
            std::mem::size_of::<u32>() as i32,
        );

        if !socks5::handshake(s, dest) {
            log(&format!("redirect: socket={s} SOCKS5 handshake failed or timed out"));
            false
        } else {
            log(&format!("redirect: socket={s} ok"));
            true
        }
    };

    let no_timeout: u32 = 0;
    setsockopt(s, SOL_SOCKET as i32, SO_RCVTIMEO, &no_timeout as *const u32 as *const u8, 4);
    setsockopt(s, SOL_SOCKET as i32, SO_SNDTIMEO, &no_timeout as *const u32 as *const u8, 4);

    if was_nonblocking {
        set_blocking(s, false);
    }
    ok
}

unsafe extern "system" fn detour_connect(s: SOCKET, addr: *const SOCKADDR, len: i32) -> i32 {
    let Some(dest) = destination_from_sockaddr(addr, len) else {
        log(&format!("connect: passthrough (socket={s})"));
        let original = ORIGINAL_CONNECT.get().copied().unwrap();
        let real: ConnectFn = std::mem::transmute(original);
        return real(s, addr, len);
    };

    log(&format!("connect: redirecting socket={s} dest={}", dest_str(&dest)));
    if redirect_and_handshake(s, &dest) {
        log(&format!("connect: redirect ok socket={s}"));
        0
    } else {
        log(&format!("connect: redirect FAILED socket={s}"));
        WSASetLastError(WSAECONNREFUSED);
        -1
    }
}

fn dest_str(dest: &Destination) -> String {
    match dest {
        Destination::Ip(ip, port) => format!("{ip}:{port}"),
        Destination::Domain(host, port) => format!("{host}:{port}"),
    }
}

unsafe extern "system" fn detour_wsaconnect(
    s: SOCKET,
    addr: *const SOCKADDR,
    len: i32,
    lp_caller_data: *mut c_void,
    lp_callee_data: *mut c_void,
    lp_sqos: *const c_void,
    lp_gqos: *const c_void,
) -> i32 {
    let Some(dest) = destination_from_sockaddr(addr, len) else {
        let original = ORIGINAL_WSACONNECT.get().copied().unwrap();
        let real: WsaConnectFn = std::mem::transmute(original);
        return real(s, addr, len, lp_caller_data, lp_callee_data, lp_sqos, lp_gqos);
    };

    // QOS / caller-callee data (rarely used outside legacy code) isn't
    // carried across the redirect in v1 — acceptable for the plain-connect
    // usage this hook is meant to cover.
    if redirect_and_handshake(s, &dest) {
        0
    } else {
        WSASetLastError(WSAECONNREFUSED);
        -1
    }
}

unsafe extern "system" fn detour_getaddrinfo(
    node: *const u8,
    service: *const u8,
    hints: *const ADDRINFOA,
    result: *mut *mut ADDRINFOA,
) -> i32 {
    let original = ORIGINAL_GETADDRINFO.get().copied().unwrap();
    let real: GetAddrInfoFn = std::mem::transmute(original);
    let rc = real(node, service, hints, result);

    if rc == 0 && !node.is_null() && !result.is_null() {
        if let Ok(host) = CStr::from_ptr(node as *const i8).to_str() {
            let host = host.to_string();
            let mut entry = *result;
            while !entry.is_null() {
                let info = &*entry;
                if info.ai_family == AF_INET as i32
                    && !info.ai_addr.is_null()
                    && (info.ai_addrlen as usize) >= std::mem::size_of::<SOCKADDR_IN>()
                {
                    let addr_in = &*(info.ai_addr as *const SOCKADDR_IN);
                    let raw = addr_in.sin_addr.S_un.S_addr.to_ne_bytes();
                    hostnames::record(Ipv4Addr::new(raw[0], raw[1], raw[2], raw[3]), host.clone());
                }
                entry = info.ai_next;
            }
        }
    }
    rc
}

/// Wide/Unicode counterpart of `getaddrinfo` — the one libuv (and so Node,
/// and anything else built on it) actually calls on Windows. Missing this
/// hook was a real gap found by the `ConnectEx` integration test: Node's
/// connection completed fine, but the router only ever saw a raw IP because
/// nothing had recorded its hostname.
unsafe extern "system" fn detour_getaddrinfo_w(
    node: *const u16,
    service: *const u16,
    hints: *const ADDRINFOW,
    result: *mut *mut ADDRINFOW,
) -> i32 {
    let original = ORIGINAL_GETADDRINFOW.get().copied().unwrap();
    let real: GetAddrInfoWFn = std::mem::transmute(original);
    let rc = real(node, service, hints, result);

    if rc == 0 && !node.is_null() && !result.is_null() {
        if let Some(host) = wide_cstr_to_string(node) {
            let mut entry = *result;
            while !entry.is_null() {
                let info = &*entry;
                if info.ai_family == AF_INET as i32
                    && !info.ai_addr.is_null()
                    && (info.ai_addrlen as usize) >= std::mem::size_of::<SOCKADDR_IN>()
                {
                    let addr_in = &*(info.ai_addr as *const SOCKADDR_IN);
                    let raw = addr_in.sin_addr.S_un.S_addr.to_ne_bytes();
                    hostnames::record(Ipv4Addr::new(raw[0], raw[1], raw[2], raw[3]), host.clone());
                }
                entry = info.ai_next;
            }
        }
    }
    rc
}

unsafe fn wide_cstr_to_string(ptr: *const u16) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    let mut len = 0usize;
    while *ptr.add(len) != 0 {
        len += 1;
    }
    let slice = std::slice::from_raw_parts(ptr, len);
    Some(String::from_utf16_lossy(slice))
}

unsafe extern "system" fn detour_wsaioctl(
    s: SOCKET,
    control_code: u32,
    in_buffer: *const c_void,
    in_size: u32,
    out_buffer: *mut c_void,
    out_size: u32,
    bytes_returned: *mut u32,
    overlapped: *mut OVERLAPPED,
    completion_routine: *mut c_void,
) -> i32 {
    let original = ORIGINAL_WSAIOCTL.get().copied().unwrap();
    let real: WsaIoctlFn = std::mem::transmute(original);

    let wants_connect_ex = control_code == SIO_GET_EXTENSION_FUNCTION_POINTER
        && !in_buffer.is_null()
        && in_size as usize >= std::mem::size_of::<GUID>()
        && guid_eq(&*(in_buffer as *const GUID), &WSAID_CONNECTEX);

    if wants_connect_ex
        && !out_buffer.is_null()
        && out_size as usize >= std::mem::size_of::<usize>()
    {
        log("WSAIoctl: substituting ConnectEx pointer");
        let detour_ptr: ConnectExFn = detour_connect_ex;
        *(out_buffer as *mut usize) = detour_ptr as *const () as usize;
        if !bytes_returned.is_null() {
            *bytes_returned = std::mem::size_of::<usize>() as u32;
        }
        return 0;
    }

    real(
        s,
        control_code,
        in_buffer,
        in_size,
        out_buffer,
        out_size,
        bytes_returned,
        overlapped,
        completion_routine,
    )
}

unsafe extern "system" fn detour_create_io_completion_port(
    file_handle: HANDLE,
    existing_completion_port: HANDLE,
    completion_key: usize,
    number_of_concurrent_threads: u32,
) -> HANDLE {
    let original = ORIGINAL_CREATE_IO_COMPLETION_PORT.get().copied().unwrap();
    let real: CreateIoCompletionPortFn = std::mem::transmute(original);
    let result = real(
        file_handle,
        existing_completion_port,
        completion_key,
        number_of_concurrent_threads,
    );

    // A non-null ExistingCompletionPort means "associate FileHandle with
    // this port", as opposed to "create a fresh port" (which passes null
    // there). Only the association case is relevant to us.
    if !existing_completion_port.is_null() && !result.is_null() {
        log(&format!(
            "CreateIoCompletionPort: associated handle={file_handle:?} iocp={existing_completion_port:?} key={completion_key}"
        ));
        iocp_associations().lock().unwrap().insert(
            file_handle as isize,
            (existing_completion_port as isize, completion_key),
        );
    }
    result
}

/// `ULONG_PTR`-typed `Internal` field values (NTSTATUS-derived), written into
/// the caller's `OVERLAPPED` before signaling completion.
const STATUS_SUCCESS: usize = 0;
const STATUS_CONNECTION_REFUSED: usize = 0xC0000236;

/// Real `ConnectEx` returns essentially immediately — `TRUE` for a rare
/// synchronous completion, or (the overwhelmingly common case) `FALSE` with
/// `WSA_IO_PENDING`, with the actual connect happening in the kernel and a
/// completion notification arriving later. The first version of this detour
/// did the whole redirect (real network round-trip + SOCKS5 handshake)
/// *synchronously inside the call*, on whatever thread invoked it — for
/// libuv's Windows backend, that's the main event-loop thread, which
/// `uv_tcp_connect` calls `ConnectEx` from directly specifically *because*
/// it's supposed to never block. Blocking it repeatedly, back-to-back, for
/// real network latency was never something the caller could expect from
/// `ConnectEx` — root-caused via a live cdb attach to a real crashing
/// RedisInsight process to a garbage-pointer dereference inside V8/libuv's
/// own code, the kind of corruption that fits a timing/reentrancy assumption
/// being violated rather than a simple logic bug. Fixed by actually doing
/// the redirect on a background thread and only ever returning "pending"
/// here, so the calling thread is never blocked — matching the real
/// contract instead of just faking its data shape.
unsafe extern "system" fn detour_connect_ex(
    s: SOCKET,
    name: *const SOCKADDR,
    namelen: i32,
    _lp_send_buffer: *mut c_void,
    _dw_send_data_length: u32,
    lp_bytes_sent: *mut u32,
    lp_overlapped: *mut OVERLAPPED,
) -> i32 {
    if !lp_bytes_sent.is_null() {
        *lp_bytes_sent = 0;
    }

    let Some(dest) = destination_from_sockaddr(name, namelen) else {
        // IPv6 or otherwise unsupported: give the caller a clean failure
        // rather than pretending success, since we have no real ConnectEx
        // trampoline to fall back to once WSAIoctl handed out our pointer
        // instead of the genuine one. A synchronous failure here is fine —
        // real ConnectEx can also fail synchronously for immediate
        // validation errors, this never touches the redirect/threading path.
        log(&format!("ConnectEx: socket={s} unsupported address family, failing closed"));
        WSASetLastError(WSAECONNREFUSED as i32);
        return 0;
    };

    log(&format!("ConnectEx: socket={s} queuing async redirect dest={}", dest_str(&dest)));
    let overlapped_addr = lp_overlapped as usize;
    std::thread::spawn(move || {
        let lp_overlapped = overlapped_addr as *mut OVERLAPPED;
        let ok = redirect_and_handshake(s, &dest);
        if !ok {
            log(&format!("ConnectEx: socket={s} async redirect FAILED"));
            signal_connect_ex_completion(s, lp_overlapped, STATUS_CONNECTION_REFUSED);
            return;
        }

        // Required per ConnectEx's own contract (MSDN): "the SO_UPDATE_CONNECT_CONTEXT
        // option must be set... before any calls to shutdown, getpeername, getsockname,
        // or setsockopt succeed." A plain connect() (what redirect_and_handshake
        // actually does under the hood) never sets this AFD-internal context the way a
        // real ConnectEx does — without it, libuv's own post-completion bookkeeping
        // (getpeername/setsockopt right after the completion fires) sees inconsistent
        // socket state.
        let update_rc =
            setsockopt(s, SOL_SOCKET as i32, SO_UPDATE_CONNECT_CONTEXT, std::ptr::null(), 0);
        log(&format!("ConnectEx: socket={s} async redirect ok, SO_UPDATE_CONNECT_CONTEXT rc={update_rc}"));
        signal_connect_ex_completion(s, lp_overlapped, STATUS_SUCCESS);
    });

    WSASetLastError(WSA_IO_PENDING);
    0 // FALSE — pending, exactly like the real thing
}

/// Writes the completion status into the caller's `OVERLAPPED` and delivers
/// it the way the caller is actually waiting for it: posted to the tracked
/// IOCP if the socket was associated with one, otherwise `SetEvent` on
/// `hOverlapped->hEvent` if present.
unsafe fn signal_connect_ex_completion(s: SOCKET, lp_overlapped: *mut OVERLAPPED, status: usize) {
    if lp_overlapped.is_null() {
        log(&format!("ConnectEx: socket={s} lpOverlapped is null, cannot signal"));
        return;
    }
    (*lp_overlapped).Internal = status;
    (*lp_overlapped).InternalHigh = 0;

    let association = iocp_associations()
        .lock()
        .unwrap()
        .get(&(s as isize))
        .copied();
    if let Some((iocp, key)) = association {
        log(&format!("ConnectEx: socket={s} posting to iocp={iocp:?} key={key}"));
        let posted = windows_sys::Win32::System::IO::PostQueuedCompletionStatus(
            iocp as HANDLE,
            0,
            key,
            lp_overlapped,
        );
        log(&format!("ConnectEx: socket={s} PostQueuedCompletionStatus returned {posted}"));
    } else if !(*lp_overlapped).hEvent.is_null() {
        log(&format!("ConnectEx: socket={s} no IOCP association, signaling hEvent"));
        windows_sys::Win32::System::Threading::SetEvent((*lp_overlapped).hEvent);
    } else {
        log(&format!(
            "ConnectEx: socket={s} no IOCP association and no hEvent — caller has no way to learn of completion"
        ));
    }
}
