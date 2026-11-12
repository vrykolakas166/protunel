//! Non-Windows stand-ins for `inject` and `pid_lookup`. Nothing can be
//! launched, so nothing is ever tracked: `CaptureState` stays empty and the
//! router's `has_active()` gate keeps `owning_pid` off the connection path.

pub mod inject {
    use std::path::Path;

    const UNSUPPORTED: &str = "process capture is only supported on Windows";

    pub struct LaunchedProcess {
        pub pid: u32,
    }

    pub fn launch(
        _exe_path: &str,
        _args: &[String],
        _hook_dll_path: &Path,
        _router_port: u16,
    ) -> Result<LaunchedProcess, String> {
        Err(UNSUPPORTED.to_string())
    }

    pub fn is_running(_pid: u32) -> bool {
        false
    }

    pub fn exe_path_of(_pid: u32) -> Option<String> {
        None
    }

    pub fn terminate(_pid: u32) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }
}

pub mod pid_lookup {
    pub fn owning_pid(_local_port: u16) -> Option<u32> {
        None
    }
}
