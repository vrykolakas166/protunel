//! Enumerates the machine's active IPv4 addresses, for display in the UI.
//! Uses `GetAdaptersAddresses` directly rather than pulling in a crate —
//! `windows-sys` with this exact feature set is already linked for the
//! capture module's TCP table lookups (`capture/pid_lookup.rs`).

use std::net::Ipv4Addr;

use windows_sys::Win32::Foundation::ERROR_BUFFER_OVERFLOW;
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
    GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
};
use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_UNSPEC, SOCKADDR_IN};

#[tauri::command]
pub fn list_local_ips() -> Result<Vec<String>, String> {
    // 15,000 bytes is Microsoft's documented starting size for this call; the
    // loop below grows it if that guess is ever too small.
    let mut buf_len: u32 = 15_000;
    let mut buffer: Vec<u8>;

    let result = loop {
        buffer = vec![0u8; buf_len as usize];
        let result = unsafe {
            GetAdaptersAddresses(
                AF_UNSPEC as u32,
                GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER,
                std::ptr::null(),
                buffer.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH,
                &mut buf_len,
            )
        };
        if result != ERROR_BUFFER_OVERFLOW {
            break result;
        }
    };
    if result != 0 {
        return Err(format!("GetAdaptersAddresses failed with code {result}"));
    }

    let mut ips = Vec::new();
    // SAFETY: `buffer` was sized and filled by the successful call above, so
    // it holds a well-formed `IP_ADAPTER_ADDRESSES_LH` linked list; every
    // `Next`/`FirstUnicastAddress` pointer we follow was set by that same
    // call or is null.
    unsafe {
        let mut adapter = buffer.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
        while !adapter.is_null() {
            let a = &*adapter;
            if a.OperStatus == IfOperStatusUp {
                let mut unicast = a.FirstUnicastAddress;
                while !unicast.is_null() {
                    let u = &*unicast;
                    let sockaddr = u.Address.lpSockaddr;
                    if !sockaddr.is_null() && (*sockaddr).sa_family == AF_INET {
                        let sockaddr_in = &*(sockaddr as *const SOCKADDR_IN);
                        let b = sockaddr_in.sin_addr.S_un.S_un_b;
                        let ip = Ipv4Addr::new(b.s_b1, b.s_b2, b.s_b3, b.s_b4);
                        if !ip.is_loopback() {
                            ips.push(ip.to_string());
                        }
                    }
                    unicast = u.Next;
                }
            }
            adapter = a.Next;
        }
    }

    ips.sort();
    ips.dedup();
    Ok(ips)
}
