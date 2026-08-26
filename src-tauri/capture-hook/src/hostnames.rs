//! Remembers hostname -> IPv4 mappings observed via the `getaddrinfo`/
//! `GetAddrInfoW` hooks, so the later `connect`/`WSAConnect`/`ConnectEx` hooks
//! can recover the original hostname the app asked for and forward it to the
//! router as a SOCKS5 domain-ATYP target — otherwise the router only ever
//! sees a raw IP, and host-wildcard/regex rules never fire for captured
//! traffic. Mirrors the app's own router philosophy of preferring the
//! hostname the caller asked for over a locally-resolved IP.

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Mutex, OnceLock};

fn table() -> &'static Mutex<HashMap<Ipv4Addr, String>> {
    static TABLE: OnceLock<Mutex<HashMap<Ipv4Addr, String>>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn record(ip: Ipv4Addr, host: String) {
    table().lock().unwrap().insert(ip, host);
}

pub fn lookup(ip: Ipv4Addr) -> Option<String> {
    table().lock().unwrap().get(&ip).cloned()
}
