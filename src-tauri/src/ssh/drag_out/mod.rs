//! Expose remote files as copy-only OLE virtual files.

mod entries;
mod ole;

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewWindow};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use windows::core::{implement, BOOL, HRESULT};
use windows::Win32::{
    Foundation::{DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, S_OK},
    System::{
        Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
        Ole::{DoDragDrop, IDropSource, IDropSource_Impl, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE},
        SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS},
    },
    UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON},
};

use super::sftp;

use entries::{descriptor, enumerate};
use ole::{make_data_object, Extraction, Formats};

fn left_button_down() -> bool {
    // SAFETY: Querying a virtual key takes no pointers. The high bit reports whether it is down.
    (unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) }) < 0
}

pub async fn start(
    app: &AppHandle,
    window: WebviewWindow,
    tunnel: Uuid,
    paths: Vec<String>,
) -> Result<(), String> {
    if !left_button_down() {
        return Ok(());
    }
    let released = CancellationToken::new();
    let stop = CancellationToken::new();
    let stop_polling = stop.clone().drop_guard();
    let release = released.clone();
    std::thread::Builder::new()
        .name("sftp-drag-out-button".into())
        .spawn(move || {
            while !stop.is_cancelled() {
                if !left_button_down() {
                    release.cancel();
                    break;
                }
                std::thread::sleep(Duration::from_millis(16));
            }
        })
        .map_err(|e| e.to_string())?;
    let sftp = sftp::sftp_for(app, tunnel).await;
    if released.is_cancelled() {
        return Ok(());
    }
    let sftp = sftp?;
    let entries = enumerate(&sftp, paths, &released).await;
    if released.is_cancelled() {
        return Ok(());
    }
    let entries = entries?;
    if entries.is_empty() {
        return Ok(());
    }
    let descriptors = entries
        .iter()
        .map(descriptor)
        .collect::<Result<Vec<_>, _>>()?;
    let formats = Formats::register().map_err(|e| e.to_string())?;
    let (keep_mta, mta_lifetime) = std::sync::mpsc::channel();
    let extraction = Arc::new(Extraction::new(app.clone(), tunnel, sftp, keep_mta));
    let (ready, data) = oneshot::channel();
    let worker_extraction = extraction.clone();
    std::thread::Builder::new()
        .name("sftp-drag-out-com".into())
        .spawn(move || {
            // SAFETY: This fresh thread initializes COM once, as an MTA.
            let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok();
            if let Err(e) = initialized {
                let _ = ready.send(Err(e));
                return;
            }
            let data = make_data_object(formats, entries, descriptors, worker_extraction);
            let _ = ready.send(data);
            // COM can dispatch standard-marshaled calls while this thread waits.
            // Keep the apartment alive until the data object and all streams are released.
            let _ = mta_lifetime.recv();
            // SAFETY: All apartment leases are gone and this balances initialization above.
            unsafe { CoUninitialize() };
        })
        .map_err(|e| e.to_string())?;
    let data = data
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let (started, reply) = oneshot::channel();
    let label = window.label().to_owned();
    drop(window);
    let ui_app = app.clone();
    app.run_on_main_thread(move || {
        let data = match data.resolve() {
            Ok(data) => data,
            Err(e) => {
                let _ = started.send(Err(e.to_string()));
                return;
            }
        };
        let source: IDropSource = DropSource.into();
        let mut effect = DROPEFFECT_NONE;
        let _ = started.send(Ok(()));
        if ui_app.get_webview_window(&label).is_none()
            || !left_button_down()
            || released.is_cancelled()
        {
            return;
        }
        drop(stop_polling);
        // SAFETY: OLE is initialized on Tauri's main thread. Both interface references and
        // the writable effect live for the duration of the synchronous call.
        let result = unsafe { DoDragDrop(&data, &source, DROPEFFECT_COPY, &mut effect) };
        let op_started = {
            let operation = extraction.operation.lock().unwrap();
            // EndOperation may already have run before DoDragDrop returned.
            operation.running || operation.ended
        };
        if should_finish_after_drag(result, effect, op_started) {
            extraction.finish(result, effect);
        }
    })
    .map_err(|e| e.to_string())?;
    reply.await.map_err(|e| e.to_string())?
}

fn should_finish_after_drag(result: HRESULT, effect: DROPEFFECT, op_started: bool) -> bool {
    !op_started && (result != DRAGDROP_S_DROP || effect == DROPEFFECT_NONE)
}

#[implement(IDropSource)]
struct DropSource;

impl IDropSource_Impl for DropSource_Impl {
    fn QueryContinueDrag(&self, escape: BOOL, keys: MODIFIERKEYS_FLAGS) -> HRESULT {
        if escape.as_bool() {
            DRAGDROP_S_CANCEL
        } else if !keys.contains(MK_LBUTTON) {
            DRAGDROP_S_DROP
        } else {
            S_OK
        }
    }

    fn GiveFeedback(&self, _: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finishes_after_drag_only_when_no_target_owns_completion() {
        assert!(!should_finish_after_drag(
            DRAGDROP_S_DROP,
            DROPEFFECT_NONE,
            true
        ));
        assert!(!should_finish_after_drag(
            DRAGDROP_S_DROP,
            DROPEFFECT_COPY,
            false
        ));
        assert!(should_finish_after_drag(
            DRAGDROP_S_CANCEL,
            DROPEFFECT_NONE,
            false
        ));
        assert!(should_finish_after_drag(
            DRAGDROP_S_DROP,
            DROPEFFECT_NONE,
            false
        ));
    }
}
