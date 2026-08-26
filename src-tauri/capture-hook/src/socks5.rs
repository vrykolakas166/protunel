//! Minimal blocking SOCKS5 no-auth CONNECT handshake, run on a socket that
//! has already been connected (by the caller) to the router's loopback port.
//! Not a general SOCKS5 client — just enough of the RFC 1928 wire format to
//! talk to `router/listener.rs`, which only ever expects no-auth + CONNECT.

use std::net::Ipv4Addr;

use windows_sys::Win32::Networking::WinSock::{recv, send, SOCKET};

pub enum Destination {
    Ip(Ipv4Addr, u16),
    Domain(String, u16),
}

fn send_all(s: SOCKET, mut buf: &[u8]) -> bool {
    while !buf.is_empty() {
        let n = unsafe { send(s, buf.as_ptr(), buf.len() as i32, 0) };
        if n <= 0 {
            return false;
        }
        buf = &buf[n as usize..];
    }
    true
}

fn recv_exact(s: SOCKET, buf: &mut [u8]) -> bool {
    let mut received = 0usize;
    while received < buf.len() {
        let n = unsafe {
            recv(
                s,
                buf[received..].as_mut_ptr(),
                (buf.len() - received) as i32,
                0,
            )
        };
        if n <= 0 {
            return false;
        }
        received += n as usize;
    }
    true
}

/// `false` on any failure (router down, handshake rejected, connection
/// dropped mid-handshake) — the caller treats that as fail-closed, never as
/// "fall back to a direct connect".
pub fn handshake(s: SOCKET, dest: &Destination) -> bool {
    if !send_all(s, &[0x05, 0x01, 0x00]) {
        return false;
    }
    let mut greeting_reply = [0u8; 2];
    if !recv_exact(s, &mut greeting_reply) || greeting_reply != [0x05, 0x00] {
        return false;
    }

    let mut request = vec![0x05u8, 0x01, 0x00];
    match dest {
        Destination::Ip(ip, port) => {
            request.push(0x01);
            request.extend_from_slice(&ip.octets());
            request.extend_from_slice(&port.to_be_bytes());
        }
        Destination::Domain(host, port) => {
            let host_bytes = host.as_bytes();
            if host_bytes.len() > 255 {
                return false;
            }
            request.push(0x03);
            request.push(host_bytes.len() as u8);
            request.extend_from_slice(host_bytes);
            request.extend_from_slice(&port.to_be_bytes());
        }
    }
    if !send_all(s, &request) {
        return false;
    }

    // Header is (ver, rep, rsv, atyp); we only need `rep`, but still have to
    // drain the variable-length address + port that follows so nothing is
    // left sitting on the socket ahead of the app's own traffic.
    let mut header = [0u8; 4];
    if !recv_exact(s, &mut header) {
        return false;
    }
    if header[1] != 0x00 {
        return false;
    }
    let addr_len = match header[3] {
        0x01 => 4,
        0x03 => {
            let mut len_byte = [0u8; 1];
            if !recv_exact(s, &mut len_byte) {
                return false;
            }
            len_byte[0] as usize
        }
        0x04 => 16,
        _ => return false,
    };
    let mut rest = vec![0u8; addr_len + 2];
    recv_exact(s, &mut rest)
}
