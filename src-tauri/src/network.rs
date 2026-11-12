//! Enumerates the machine's active, non-loopback IPv4 addresses, for display
//! in the UI. Uses the OS interface APIs directly rather than pulling in a
//! crate: `GetAdaptersAddresses` on Windows (`windows-sys` with this feature
//! set is already linked for `capture/pid_lookup.rs`), `getifaddrs` elsewhere.

#[tauri::command]
pub fn list_local_ips() -> Result<Vec<String>, String> {
    let mut ips: Vec<String> = platform::active_ipv4()?
        .into_iter()
        .filter(|ip| !ip.is_loopback())
        .map(|ip| ip.to_string())
        .collect();
    ips.sort();
    ips.dedup();
    Ok(ips)
}

#[cfg(windows)]
mod platform {
    use std::net::Ipv4Addr;

    use windows_sys::Win32::Foundation::ERROR_BUFFER_OVERFLOW;
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_UNSPEC, SOCKADDR_IN};

    pub fn active_ipv4() -> Result<Vec<Ipv4Addr>, String> {
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
                            ips.push(Ipv4Addr::new(b.s_b1, b.s_b2, b.s_b3, b.s_b4));
                        }
                        unicast = u.Next;
                    }
                }
                adapter = a.Next;
            }
        }

        Ok(ips)
    }
}

#[cfg(unix)]
mod platform {
    use std::net::Ipv4Addr;

    pub fn active_ipv4() -> Result<Vec<Ipv4Addr>, String> {
        let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
        if unsafe { libc::getifaddrs(&mut head) } != 0 {
            return Err(format!("getifaddrs failed: {}", std::io::Error::last_os_error()));
        }

        // "Up" here matches Windows' IfOperStatusUp: administratively up *and*
        // the link is running, so an unplugged cable does not list an address.
        let want = (libc::IFF_UP | libc::IFF_RUNNING) as libc::c_uint;
        let mut ips = Vec::new();
        // SAFETY: `head` is the list `getifaddrs` just returned; every
        // `ifa_next`/`ifa_addr` we follow was set by it or is null, and an
        // `AF_INET` address is a `sockaddr_in`. Freed exactly once below.
        unsafe {
            let mut cur = head;
            while !cur.is_null() {
                let ifa = &*cur;
                let addr = ifa.ifa_addr;
                if ifa.ifa_flags & want == want
                    && !addr.is_null()
                    && (*addr).sa_family as libc::c_int == libc::AF_INET
                {
                    let sin = &*(addr as *const libc::sockaddr_in);
                    ips.push(Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr)));
                }
                cur = ifa.ifa_next;
            }
            libc::freeifaddrs(head);
        }
        Ok(ips)
    }
}
