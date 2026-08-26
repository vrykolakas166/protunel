//! Recovers the PID that owns a loopback connection into the router, given
//! the ephemeral local port the OS assigned the captured process's socket
//! (which is exactly the peer port the router's `accept()` sees). Same
//! technique `netstat -b`/`-o` use internally — no protocol change needed on
//! the hook DLL side, the router just asks Windows who owns that 4-tuple.

use windows_sys::Win32::Foundation::NO_ERROR;
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
};
use windows_sys::Win32::Networking::WinSock::AF_INET;

/// `None` if the connection already closed by the time this runs, or the
/// lookup otherwise fails — attribution is best-effort UI sugar, never load
/// bearing for routing itself.
pub fn owning_pid(local_port: u16) -> Option<u32> {
    unsafe {
        let mut size: u32 = 0;
        GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        );
        if size == 0 {
            return None;
        }

        let mut buffer = vec![0u8; size as usize];
        let result = GetExtendedTcpTable(
            buffer.as_mut_ptr() as *mut _,
            &mut size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        );
        if result != NO_ERROR {
            return None;
        }

        let table = &*(buffer.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
        let count = table.dwNumEntries as usize;
        let rows = std::slice::from_raw_parts(table.table.as_ptr(), count);

        // Matching on local port alone is enough here: it's an OS-assigned
        // ephemeral port on 127.0.0.1, collision with an unrelated
        // connection at the exact moment we look is not a realistic concern
        // for a best-effort attribution feature.
        rows.iter()
            .find(|row| u16::from_be((row.dwLocalPort & 0xFFFF) as u16) == local_port)
            .map(|row| row.dwOwningPid)
    }
}
