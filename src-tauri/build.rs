use std::fs;
use std::path::Path;

fn main() {
    // tauri_build::build() validates every bundle.resources path exists, even
    // for a plain `cargo check`/`cargo test` that never touches the JS build
    // pipeline (scripts/build-hook-dll.mjs). Seed an empty placeholder so
    // those keep working standalone, as CLAUDE.md documents — the real DLL
    // overwrites this before an actual dev run or bundle.
    let resources_dir = Path::new("resources");
    let hook_dll = resources_dir.join("capture_hook.dll");
    if !hook_dll.exists() {
        fs::create_dir_all(resources_dir).expect("create resources dir");
        fs::write(&hook_dll, []).expect("seed capture_hook.dll placeholder");
    }

    tauri_build::build()
}
