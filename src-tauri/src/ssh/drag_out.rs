//! Expose remote files as copy-only OLE virtual files.

use std::collections::HashMap;
use std::ffi::c_void;
use std::mem::{offset_of, size_of, ManuallyDrop, MaybeUninit};
use std::ptr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh_sftp::{client::SftpSession, protocol::FileAttributes};
use tauri::{AppHandle, Manager, WebviewWindow};
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use windows::core::{
    implement, AgileReference, Error, Interface, Ref, Result as ComResult, BOOL, HRESULT, PWSTR,
};
use windows::Win32::{
    Foundation::{
        GlobalFree, DATA_S_SAMEFORMATETC, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP,
        DRAGDROP_S_USEDEFAULTCURSORS, DV_E_CLIPFORMAT, DV_E_DVASPECT, DV_E_DVTARGETDEVICE,
        DV_E_LINDEX, DV_E_TYMED, ERROR_CANCELLED, E_ABORT, E_NOTIMPL, E_OUTOFMEMORY, E_POINTER,
        FILETIME, OLE_E_ADVISENOTSUPPORTED, STG_E_ACCESSDENIED, STG_E_READFAULT, S_FALSE, S_OK,
    },
    Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL},
    System::{
        Com::{
            CoInitializeEx, CoTaskMemAlloc, CoUninitialize, IAdviseSink, IBindCtx, IDataObject,
            IDataObject_Impl, IEnumFORMATETC, IEnumSTATDATA, ISequentialStream_Impl, IStream,
            IStream_Impl, COINIT_MULTITHREADED, DATADIR_GET, DVASPECT_CONTENT, FORMATETC, LOCKTYPE,
            STATFLAG, STATFLAG_DEFAULT, STATSTG, STGC, STGMEDIUM, STGMEDIUM_0, STGM_READ,
            STGTY_STREAM, STREAM_SEEK, STREAM_SEEK_CUR, TYMED_HGLOBAL, TYMED_ISTREAM,
        },
        DataExchange::RegisterClipboardFormatW,
        Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
        Ole::{
            DoDragDrop, IDropSource, IDropSource_Impl, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
        },
        SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS},
    },
    UI::{
        Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON},
        Shell::{
            IDataObjectAsyncCapability, IDataObjectAsyncCapability_Impl, SHCreateStdEnumFmtEtc,
            CFSTR_FILECONTENTS, CFSTR_FILEDESCRIPTORW, CFSTR_PREFERREDDROPEFFECT, FD_ATTRIBUTES,
            FD_FILESIZE, FD_PROGRESSUI, FD_UNICODE, FD_WRITESTIME, FILEDESCRIPTORW,
            FILEGROUPDESCRIPTORW,
        },
    },
};

use super::sftp::{self, Direction, Transfer, TransferState, CHUNK, PROGRESS_EVERY};

const ENTRY_LIMIT: usize = 20_000;
const READ_AHEAD: usize = 32;

struct Entry {
    remote: String,
    relative: String,
    directory: bool,
    size: u64,
    mtime: Option<u32>,
}

/// Allocate a Windows-safe component among the files and folders of one parent.
fn unique_name(name: &str, used: &mut HashMap<String, u32>) -> String {
    let sanitized = sftp::sanitize(name);
    let mut name = sanitized.trim_end_matches(['.', ' ']).to_owned();
    if name.is_empty() {
        name.push('_');
    }
    let device_end = name.find('.').unwrap_or(name.len());
    let device = name[..device_end]
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    if matches!(
        device.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || device
        .strip_prefix("COM")
        .or_else(|| device.strip_prefix("LPT"))
        .is_some_and(|n| {
            matches!(
                n,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    {
        name.insert(device_end, '_');
    }

    let key = name.to_uppercase();
    if let std::collections::hash_map::Entry::Vacant(slot) = used.entry(key.clone()) {
        slot.insert(1);
        return name;
    }
    let (stem, ext) = sftp::stem_ext(&name);
    let mut number = used[&key];
    loop {
        let candidate = format!("{stem} ({number}){ext}");
        number += 1;
        if let std::collections::hash_map::Entry::Vacant(slot) =
            used.entry(candidate.to_uppercase())
        {
            slot.insert(1);
            used.insert(key, number);
            return candidate;
        }
    }
}

fn descriptor_name(relative: &str) -> Result<[u16; 260], String> {
    let mut name = [0; 260];
    for (i, unit) in relative.encode_utf16().enumerate() {
        if i == name.len() - 1 {
            return Err(format!("path-too-long:{relative}"));
        }
        name[i] = unit;
    }
    Ok(name)
}

fn filetime(unix_seconds: u32) -> FILETIME {
    let ticks = (u64::from(unix_seconds) + 11_644_473_600) * 10_000_000;
    FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    }
}

fn descriptor(entry: &Entry) -> Result<FILEDESCRIPTORW, String> {
    Ok(FILEDESCRIPTORW {
        dwFlags: (FD_ATTRIBUTES.0
            | FD_FILESIZE.0
            | FD_WRITESTIME.0
            | FD_PROGRESSUI.0
            | FD_UNICODE.0) as u32,
        dwFileAttributes: if entry.directory {
            FILE_ATTRIBUTE_DIRECTORY.0
        } else {
            FILE_ATTRIBUTE_NORMAL.0
        },
        ftLastWriteTime: entry.mtime.map(filetime).unwrap_or_default(),
        nFileSizeHigh: (entry.size >> 32) as u32,
        nFileSizeLow: entry.size as u32,
        cFileName: descriptor_name(&entry.relative)?,
        ..Default::default()
    })
}

/// Appending before visiting makes the descriptor order a breadth-first walk.
#[derive(Default)]
struct Entries {
    all: Vec<Entry>,
    next: usize,
}

impl Entries {
    fn push(
        &mut self,
        remote: String,
        parent: &str,
        used: &mut HashMap<String, u32>,
        attrs: FileAttributes,
    ) -> Result<(), String> {
        let directory = attrs.is_dir();
        if !directory && !attrs.is_regular() {
            return Ok(());
        }
        if self.all.len() == ENTRY_LIMIT {
            return Err("too-many".into());
        }
        let name = unique_name(sftp::split(&remote).1, used);
        let relative = if parent.is_empty() {
            name
        } else {
            format!("{parent}\\{name}")
        };
        descriptor_name(&relative)?;
        let size = if directory {
            0
        } else {
            attrs
                .size
                .ok_or_else(|| format!("{remote}: SFTP did not report the file size"))?
        };
        self.all.push(Entry {
            remote,
            relative,
            directory,
            size,
            mtime: attrs.mtime,
        });
        Ok(())
    }

    fn next_directory(&mut self) -> Option<(String, String)> {
        while let Some(entry) = self.all.get(self.next) {
            self.next += 1;
            if entry.directory {
                return Some((entry.remote.clone(), entry.relative.clone()));
            }
        }
        None
    }
}

async fn enumerate(
    sftp: &SftpSession,
    paths: Vec<String>,
    released: &CancellationToken,
) -> Result<Vec<Entry>, String> {
    let mut entries = Entries::default();
    let mut roots = HashMap::new();
    for path in paths {
        if released.is_cancelled() {
            return Ok(Vec::new());
        }
        // A trailing slash would make LSTAT dereference a directory symlink.
        let path = if path == "/" {
            path.as_str()
        } else {
            path.trim_end_matches('/')
        };
        let attrs = sftp.symlink_metadata(path).await.map_err(sftp::err)?;
        entries.push(path.into(), "", &mut roots, attrs)?;
    }
    while let Some((remote, relative)) = entries.next_directory() {
        let mut children = HashMap::new();
        if released.is_cancelled() {
            return Ok(Vec::new());
        }
        for child in sftp.read_dir(&remote).await.map_err(sftp::err)? {
            if released.is_cancelled() {
                return Ok(Vec::new());
            }
            let name = child.file_name();
            let name = name.as_str();
            // A directory entry must address a single child of the listed folder.
            if matches!(name, "" | "." | "..") || name.contains(['/', '\0']) {
                continue;
            }
            let path = sftp::join(&remote, name);
            entries.push(path, &relative, &mut children, child.metadata())?;
        }
    }
    Ok(entries.all)
}

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
    let extraction = Arc::new(Extraction {
        app: app.clone(),
        tunnel,
        sftp,
        operation: Mutex::new(Operation::default()),
        _keep_mta: keep_mta,
    });
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

struct Formats {
    descriptor: u16,
    contents: u16,
    preferred: u16,
}

impl Formats {
    fn register() -> ComResult<Self> {
        fn register(name: windows::core::PCWSTR) -> ComResult<u16> {
            // SAFETY: Each call uses a static, NUL-terminated shell format constant.
            let id = unsafe { RegisterClipboardFormatW(name) };
            if id == 0 {
                Err(Error::from_thread())
            } else {
                Ok(id as u16)
            }
        }
        Ok(Self {
            descriptor: register(CFSTR_FILEDESCRIPTORW)?,
            contents: register(CFSTR_FILECONTENTS)?,
            preferred: register(CFSTR_PREFERREDDROPEFFECT)?,
        })
    }
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

fn make_data_object(
    formats: Formats,
    entries: Vec<Entry>,
    descriptors: Vec<FILEDESCRIPTORW>,
    extraction: Arc<Extraction>,
) -> ComResult<AgileReference<IDataObject>> {
    let data: IDataObject = DataObject {
        formats,
        entries,
        descriptors,
        extraction,
    }
    .into();
    let async_data = data.cast::<IDataObjectAsyncCapability>()?;
    // SAFETY: The interface is live and the BOOL is passed by value.
    unsafe { async_data.SetAsyncMode(true) }?;
    AgileReference::new(&data)
}

// Standard marshaling routes cross-process Explorer calls to the MTA that owns
// this object, keeping blocking IStream reads off the UI apartment.
#[implement(IDataObject, IDataObjectAsyncCapability, Agile = false)]
struct DataObject {
    formats: Formats,
    entries: Vec<Entry>,
    descriptors: Vec<FILEDESCRIPTORW>,
    extraction: Arc<Extraction>,
}

enum Format<'a> {
    Descriptor,
    Contents(&'a Entry),
    Preferred,
}

impl DataObject {
    fn format(&self, format: *const FORMATETC) -> ComResult<Format<'_>> {
        // SAFETY: COM calls supply a readable FORMATETC for the duration of the call.
        let format = unsafe { format.as_ref() }.ok_or(E_POINTER)?;
        if format.dwAspect != DVASPECT_CONTENT.0 {
            return Err(DV_E_DVASPECT.into());
        }
        if !format.ptd.is_null() {
            return Err(DV_E_DVTARGETDEVICE.into());
        }
        let (value, tymed) = if format.cfFormat == self.formats.contents {
            let entry = self
                .entries
                .get(format.lindex as usize)
                .filter(|e| !e.directory)
                .ok_or(DV_E_LINDEX)?;
            (Format::Contents(entry), TYMED_ISTREAM)
        } else {
            let value = if format.cfFormat == self.formats.descriptor {
                Format::Descriptor
            } else if format.cfFormat == self.formats.preferred {
                Format::Preferred
            } else {
                return Err(DV_E_CLIPFORMAT.into());
            };
            if format.lindex != -1 {
                return Err(DV_E_LINDEX.into());
            }
            (value, TYMED_HGLOBAL)
        };
        if format.tymed & tymed.0 as u32 == 0 {
            return Err(DV_E_TYMED.into());
        }
        Ok(value)
    }
}

impl IDataObject_Impl for DataObject_Impl {
    fn GetData(&self, format: *const FORMATETC) -> ComResult<STGMEDIUM> {
        match self.format(format)? {
            Format::Descriptor => {
                let offset = offset_of!(FILEGROUPDESCRIPTORW, fgd);
                let size = offset + size_of::<FILEDESCRIPTORW>() * self.descriptors.len();
                global_medium(size, |dest| {
                    // SAFETY: The allocation has room for a count and every descriptor
                    // at the native group layout offset. The sources are initialized and disjoint.
                    unsafe {
                        dest.cast::<u32>()
                            .write_unaligned(self.descriptors.len() as u32);
                        ptr::copy_nonoverlapping(
                            self.descriptors.as_ptr().cast::<u8>(),
                            dest.add(offset),
                            size - offset,
                        );
                    }
                })
            }
            Format::Contents(entry) => {
                let stream = self.extraction.open_stream(entry)?;
                Ok(STGMEDIUM {
                    tymed: TYMED_ISTREAM.0 as u32,
                    u: STGMEDIUM_0 {
                        pstm: ManuallyDrop::new(Some(stream)),
                    },
                    ..Default::default()
                })
            }
            Format::Preferred => global_medium(size_of::<u32>(), |dest| {
                // SAFETY: The allocation has room for exactly one DWORD.
                unsafe { dest.cast::<u32>().write_unaligned(DROPEFFECT_COPY.0) };
            }),
        }
    }

    fn GetDataHere(&self, _: *const FORMATETC, _: *mut STGMEDIUM) -> ComResult<()> {
        Err(E_NOTIMPL.into())
    }

    fn QueryGetData(&self, format: *const FORMATETC) -> HRESULT {
        self.format(format).map_or_else(|e| e.code(), |_| S_OK)
    }

    fn GetCanonicalFormatEtc(&self, _: *const FORMATETC, output: *mut FORMATETC) -> HRESULT {
        if output.is_null() {
            return E_POINTER;
        }
        // SAFETY: COM supplies a writable output FORMATETC.
        unsafe { output.write(FORMATETC::default()) };
        DATA_S_SAMEFORMATETC
    }

    fn SetData(&self, _: *const FORMATETC, _: *const STGMEDIUM, _: BOOL) -> ComResult<()> {
        Err(E_NOTIMPL.into())
    }

    fn EnumFormatEtc(&self, direction: u32) -> ComResult<IEnumFORMATETC> {
        if direction != DATADIR_GET.0 as u32 {
            return Err(E_NOTIMPL.into());
        }
        let mut formats = Vec::new();
        let mut add = |cf_format, index, medium| {
            formats.push(FORMATETC {
                cfFormat: cf_format,
                lindex: index,
                tymed: medium,
                dwAspect: DVASPECT_CONTENT.0,
                ..Default::default()
            });
        };
        add(self.formats.descriptor, -1, TYMED_HGLOBAL.0 as u32);
        for (index, entry) in self.entries.iter().enumerate() {
            if !entry.directory {
                add(self.formats.contents, index as i32, TYMED_ISTREAM.0 as u32);
            }
        }
        add(self.formats.preferred, -1, TYMED_HGLOBAL.0 as u32);
        // SAFETY: The shell copies the live FORMATETC slice, whose target-device pointers are null.
        unsafe { SHCreateStdEnumFmtEtc(&formats) }
    }

    fn DAdvise(&self, _: *const FORMATETC, _: u32, _: Ref<IAdviseSink>) -> ComResult<u32> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }

    fn DUnadvise(&self, _: u32) -> ComResult<()> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }

    fn EnumDAdvise(&self) -> ComResult<IEnumSTATDATA> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
}

fn global_medium(size: usize, fill: impl FnOnce(*mut u8)) -> ComResult<STGMEDIUM> {
    // SAFETY: The nonzero size comes from the payload layout. The handle is owned
    // here until handed to OLE via STGMEDIUM and freed by ReleaseStgMedium.
    unsafe {
        let handle = GlobalAlloc(GMEM_MOVEABLE, size)?;
        let dest = GlobalLock(handle).cast::<u8>();
        if dest.is_null() {
            let error = Error::from_thread();
            let _ = GlobalFree(Some(handle));
            return Err(error);
        }
        fill(dest);
        let _ = GlobalUnlock(handle);
        Ok(STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 { hGlobal: handle },
            ..Default::default()
        })
    }
}

impl IDataObjectAsyncCapability_Impl for DataObject_Impl {
    fn SetAsyncMode(&self, enabled: BOOL) -> ComResult<()> {
        self.extraction.operation.lock().unwrap().async_mode = enabled.as_bool();
        Ok(())
    }

    fn GetAsyncMode(&self) -> ComResult<BOOL> {
        Ok(self.extraction.operation.lock().unwrap().async_mode.into())
    }

    fn StartOperation(&self, _: Ref<IBindCtx>) -> ComResult<()> {
        let mut operation = self.extraction.operation.lock().unwrap();
        if operation.ended {
            return Err(E_ABORT.into());
        }
        operation.running = true;
        Ok(())
    }

    fn InOperation(&self) -> ComResult<BOOL> {
        Ok(self.extraction.operation.lock().unwrap().running.into())
    }

    fn EndOperation(&self, result: HRESULT, _: Ref<IBindCtx>, effect: u32) -> ComResult<()> {
        self.extraction.finish(result, DROPEFFECT(effect));
        Ok(())
    }
}

#[derive(Default)]
struct Operation {
    async_mode: bool,
    running: bool,
    ended: bool,
    streams: Vec<Arc<DragTransfer>>,
}

struct Extraction {
    app: AppHandle,
    tunnel: Uuid,
    sftp: Arc<SftpSession>,
    operation: Mutex<Operation>,
    _keep_mta: std::sync::mpsc::Sender<()>,
}

impl Extraction {
    fn open_stream(self: &Arc<Self>, entry: &Entry) -> ComResult<IStream> {
        let mut operation = self.operation.lock().unwrap();
        if operation.ended {
            return Err(E_ABORT.into());
        }
        let transfer = Arc::new(DragTransfer::new(&self.app, self.tunnel, entry));
        operation.streams.push(transfer.clone());
        drop(operation);

        let (send, recv) = mpsc::channel(READ_AHEAD);
        let stop_reader = transfer.cancel.child_token();
        tauri::async_runtime::spawn(pump(
            self.sftp.clone(),
            transfer.clone(),
            stop_reader.clone(),
            entry.remote.clone(),
            entry.size,
            send,
        ));
        Ok(FileStream {
            transfer,
            stop_reader,
            reader: Mutex::new(Reader {
                recv,
                leftover: Vec::new(),
                offset: 0,
                position: 0,
            }),
            name: entry.relative.clone(),
            size: entry.size,
            extraction: self.clone(),
        }
        .into())
    }

    fn finish(&self, result: HRESULT, effect: DROPEFFECT) {
        let streams = {
            let mut op = self.operation.lock().unwrap();
            if op.ended {
                return;
            }
            op.running = false;
            op.ended = true;
            std::mem::take(&mut op.streams)
        };
        let error = (result.is_err()
            && result != E_ABORT
            && result != HRESULT::from_win32(ERROR_CANCELLED.0))
        .then(|| Error::from_hresult(result).to_string());
        for stream in streams {
            if let Some(error) = &error {
                stream.finish(TransferState::Failed, Some(error.clone()));
            } else if effect == DROPEFFECT_COPY && result.is_ok() && result != DRAGDROP_S_CANCEL {
                // A successful target may release a stream after EndOperation.
                stream.finish_on_success();
            } else {
                stream.finish(TransferState::Cancelled, None);
            }
            stream.cancel.cancel();
        }
    }
}

impl Drop for Extraction {
    fn drop(&mut self) {
        self.finish(DRAGDROP_S_CANCEL, DROPEFFECT_NONE);
    }
}

struct Progress {
    transfer: Transfer,
    last: Instant,
    read_error: Option<String>,
}

struct DragTransfer {
    app: AppHandle,
    cancel: CancellationToken,
    progress: Mutex<Progress>,
}

impl DragTransfer {
    fn new(app: &AppHandle, tunnel: Uuid, entry: &Entry) -> Self {
        let cancel = CancellationToken::new();
        let transfer = Transfer {
            id: Uuid::new_v4(),
            tunnel_id: tunnel,
            dest_tunnel_id: None,
            route: None,
            direction: Direction::DragOut,
            name: sftp::split(&entry.remote).1.into(),
            remote_path: entry.remote.clone(),
            local_path: String::new(),
            done: 0,
            total: entry.size,
            state: TransferState::Running,
            error: None,
            open_when_done: false,
        };
        sftp::track_drag_out(app, &transfer, &cancel);
        Self {
            app: app.clone(),
            cancel,
            progress: Mutex::new(Progress {
                transfer,
                last: Instant::now(),
                read_error: None,
            }),
        }
    }

    fn advance(&self, bytes: usize) {
        if bytes == 0 {
            return;
        }
        let mut progress = self.progress.lock().unwrap();
        if progress.transfer.state == TransferState::Running {
            progress.transfer.done += bytes as u64;
            if progress.transfer.done == progress.transfer.total
                || progress.last.elapsed() >= PROGRESS_EVERY
            {
                progress.last = Instant::now();
                sftp::publish(&self.app, &progress.transfer);
            }
        }
    }

    fn finish(&self, state: TransferState, error: Option<String>) {
        let mut progress = self.progress.lock().unwrap();
        self.complete(&mut progress, state, error);
    }

    fn finish_on_success(&self) {
        let mut progress = self.progress.lock().unwrap();
        let error = progress.read_error.take();
        let state = if error.is_some() {
            TransferState::Failed
        } else if progress.transfer.done == progress.transfer.total {
            TransferState::Done
        } else {
            TransferState::Cancelled
        };
        self.complete(&mut progress, state, error);
    }

    fn record_read_error(&self, error: String) {
        self.progress
            .lock()
            .unwrap()
            .read_error
            .get_or_insert(error);
    }

    fn complete(&self, progress: &mut Progress, state: TransferState, error: Option<String>) {
        if progress.transfer.state == TransferState::Running {
            progress.transfer.state = if self.cancel.is_cancelled() {
                TransferState::Cancelled
            } else {
                state
            };
            if progress.transfer.state == TransferState::Failed {
                progress.transfer.error = error;
            }
            sftp::finish_drag_out(&self.app, &progress.transfer);
        }
    }

    fn read_status(&self) -> HRESULT {
        let progress = self.progress.lock().unwrap();
        match progress.transfer.state {
            TransferState::Failed => STG_E_READFAULT,
            TransferState::Cancelled => E_ABORT,
            TransferState::Running if self.cancel.is_cancelled() => E_ABORT,
            TransferState::Running if progress.read_error.is_some() => STG_E_READFAULT,
            _ => S_OK,
        }
    }
}

async fn pump(
    sftp: Arc<SftpSession>,
    transfer: Arc<DragTransfer>,
    stop_reader: CancellationToken,
    path: String,
    mut remaining: u64,
    send: mpsc::Sender<Vec<u8>>,
) {
    if stop_reader.is_cancelled() {
        return;
    }
    let open = async {
        let attrs = sftp
            .symlink_metadata(path.as_str())
            .await
            .map_err(sftp::err)?;
        if stop_reader.is_cancelled() {
            return Err("cancelled".into());
        }
        if !attrs.is_regular() {
            return Err("source is no longer a regular file".into());
        }
        sftp.open(path.as_str()).await.map_err(sftp::err)
    };
    tokio::pin!(open);
    let src = tokio::select! {
        biased;
        _ = stop_reader.cancelled() => {
            drop(send);
            // Complete the pending OPEN so a handle returned after cancellation can be closed.
            if let Ok(src) = open.await {
                let _ = src.close().await;
            }
            return;
        }
        result = &mut open => result,
    };
    let mut src = match src {
        Ok(src) => src,
        Err(e) => {
            transfer.record_read_error(format!("{path}: {e}"));
            return;
        }
    };
    let copied = async {
        while remaining != 0 {
            let Ok(permit) = send.reserve().await else {
                break;
            };
            let mut chunk = vec![0; remaining.min(CHUNK as u64) as usize];
            src.read_exact(&mut chunk).await?;
            remaining -= chunk.len() as u64;
            permit.send(chunk);
        }
        Ok::<(), std::io::Error>(())
    };
    tokio::select! {
        biased;
        _ = stop_reader.cancelled() => {},
        result = copied => {
            if let Err(e) = result {
                transfer.record_read_error(format!("{path}: {e}"));
            }
        }
    }
    // Wake a blocked Read before waiting on the SFTP CLOSE reply.
    drop(send);
    let _ = src.close().await;
}

#[implement(IStream, Agile = false)]
struct FileStream {
    transfer: Arc<DragTransfer>,
    stop_reader: CancellationToken,
    reader: Mutex<Reader>,
    name: String,
    size: u64,
    extraction: Arc<Extraction>,
}

struct Reader {
    recv: mpsc::Receiver<Vec<u8>>,
    leftover: Vec<u8>,
    offset: usize,
    position: u64,
}

impl Reader {
    fn read(
        &mut self,
        dest: &mut [MaybeUninit<u8>],
        transfer: &DragTransfer,
        size: u64,
    ) -> (usize, HRESULT) {
        let mut written = 0;
        while written < dest.len() {
            let status = transfer.read_status();
            if status.is_err() {
                return (0, status);
            }
            if self.offset == self.leftover.len() {
                let Some(chunk) = self.recv.blocking_recv() else {
                    break;
                };
                self.leftover = chunk;
                self.offset = 0;
                continue;
            }
            let count = (dest.len() - written).min(self.leftover.len() - self.offset);
            dest[written..written + count]
                .write_copy_of_slice(&self.leftover[self.offset..self.offset + count]);
            self.offset += count;
            written += count;
        }
        let status = transfer.read_status();
        if status.is_err() {
            return (0, status);
        }
        if written < dest.len() && self.position + (written as u64) < size {
            transfer.record_read_error("SFTP stream ended early".into());
            return (0, transfer.read_status());
        }
        self.position += written as u64;
        transfer.advance(written);
        (
            written,
            if written == 0 && !dest.is_empty() {
                S_FALSE
            } else {
                S_OK
            },
        )
    }
}

impl Drop for FileStream {
    fn drop(&mut self) {
        let op = self.extraction.operation.lock().unwrap();
        if !op.running && !op.ended {
            self.transfer.finish_on_success();
        }
        self.stop_reader.cancel();
    }
}

impl ISequentialStream_Impl for FileStream_Impl {
    fn Read(&self, buf: *mut c_void, len: u32, read: *mut u32) -> HRESULT {
        if !read.is_null() {
            // SAFETY: COM supplies a writable count when the optional pointer is non-null.
            unsafe { read.write(0) };
        }
        if len == 0 {
            return self.transfer.read_status();
        }
        if buf.is_null() || len as usize > isize::MAX as usize {
            return E_POINTER;
        }
        // SAFETY: COM supplies len writable bytes separate from the count pointer.
        // MaybeUninit permits writing into the buffer without reading its initial contents.
        let dest =
            unsafe { std::slice::from_raw_parts_mut(buf.cast::<MaybeUninit<u8>>(), len as usize) };
        let (count, result) = self
            .reader
            .lock()
            .unwrap()
            .read(dest, &self.transfer, self.size);
        if !read.is_null() {
            // SAFETY: As above, the caller-provided count is writable.
            unsafe { read.write(count as u32) };
        }
        result
    }

    fn Write(&self, _: *const c_void, _: u32, written: *mut u32) -> HRESULT {
        if !written.is_null() {
            // SAFETY: COM supplies a writable count when the optional pointer is non-null.
            unsafe { written.write(0) };
        }
        STG_E_ACCESSDENIED
    }
}

impl IStream_Impl for FileStream_Impl {
    fn Seek(&self, offset: i64, origin: STREAM_SEEK, position: *mut u64) -> ComResult<()> {
        if origin != STREAM_SEEK_CUR || offset != 0 {
            return Err(E_NOTIMPL.into());
        }
        if !position.is_null() {
            // SAFETY: The non-null COM output pointer refers to a writable ULARGE_INTEGER.
            unsafe { position.write(self.reader.lock().unwrap().position) };
        }
        Ok(())
    }

    fn SetSize(&self, _: u64) -> ComResult<()> {
        Err(STG_E_ACCESSDENIED.into())
    }

    fn CopyTo(&self, _: Ref<IStream>, _: u64, _: *mut u64, _: *mut u64) -> ComResult<()> {
        Err(E_NOTIMPL.into())
    }

    fn Commit(&self, _: &STGC) -> ComResult<()> {
        Err(E_NOTIMPL.into())
    }

    fn Revert(&self) -> ComResult<()> {
        Err(E_NOTIMPL.into())
    }

    fn LockRegion(&self, _: u64, _: u64, _: &LOCKTYPE) -> ComResult<()> {
        Err(E_NOTIMPL.into())
    }

    fn UnlockRegion(&self, _: u64, _: u64, _: u32) -> ComResult<()> {
        Err(E_NOTIMPL.into())
    }

    fn Stat(&self, stat: *mut STATSTG, flags: &STATFLAG) -> ComResult<()> {
        if stat.is_null() {
            return Err(E_POINTER.into());
        }
        let mut value = STATSTG {
            r#type: STGTY_STREAM.0 as u32,
            cbSize: self.size,
            grfMode: STGM_READ,
            ..Default::default()
        };
        if *flags == STATFLAG_DEFAULT {
            let name: Vec<u16> = self.name.encode_utf16().chain(std::iter::once(0)).collect();
            // SAFETY: The COM task allocator allocates enough space for the NUL-terminated
            // UTF-16 name. A successful Stat transfers ownership to the caller.
            unsafe {
                let dest = CoTaskMemAlloc(name.len() * size_of::<u16>()).cast::<u16>();
                if dest.is_null() {
                    return Err(E_OUTOFMEMORY.into());
                }
                ptr::copy_nonoverlapping(name.as_ptr(), dest, name.len());
                value.pwcsName = PWSTR(dest);
            }
        }
        // SAFETY: The non-null COM output pointer refers to writable STATSTG storage.
        unsafe { stat.write(value) };
        Ok(())
    }

    fn Clone(&self) -> ComResult<IStream> {
        Err(E_NOTIMPL.into())
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

    #[test]
    fn checks_utf16_units_and_keeps_the_terminator() {
        let fits = format!("a{}", "😀".repeat(129));
        assert_eq!(descriptor_name(&fits).unwrap()[259], 0);
        let long = format!(r"parent\{}", "😀".repeat(127));
        assert_eq!(descriptor_name(&long), Err(format!("path-too-long:{long}")));
    }

    #[test]
    fn describes_files_and_directories_with_the_shell_layout() {
        let mut entry = Entry {
            remote: "/tree/file".into(),
            relative: r"tree\file".into(),
            directory: false,
            size: (5 << 32) | 42,
            mtime: Some(1),
        };
        let file = descriptor(&entry).unwrap();
        assert_eq!((file.nFileSizeHigh, file.nFileSizeLow), (5, 42));
        assert_eq!({ file.cFileName }, descriptor_name(r"tree\file").unwrap());
        assert_eq!(
            { file.dwFlags },
            (FD_ATTRIBUTES.0 | FD_FILESIZE.0 | FD_WRITESTIME.0 | FD_PROGRESSUI.0 | FD_UNICODE.0)
                as u32
        );
        assert_eq!({ file.dwFileAttributes }, FILE_ATTRIBUTE_NORMAL.0);
        assert_eq!({ file.ftLastWriteTime }, filetime(1));
        entry.directory = true;
        assert_eq!(
            { descriptor(&entry).unwrap().dwFileAttributes },
            FILE_ATTRIBUTE_DIRECTORY.0
        );
        assert_eq!(offset_of!(FILEGROUPDESCRIPTORW, fgd), 4);
    }

    #[test]
    fn converts_unix_seconds_to_windows_ticks() {
        let ticks =
            |time: FILETIME| u64::from(time.dwHighDateTime) << 32 | u64::from(time.dwLowDateTime);
        assert_eq!(ticks(filetime(0)), 116_444_736_000_000_000);
        assert_eq!(ticks(filetime(1)) - ticks(filetime(0)), 10_000_000);
        assert_eq!(ticks(filetime(u32::MAX)), 159_394_408_950_000_000);
    }

    #[test]
    fn allocates_safe_names_and_resolves_case_insensitive_collisions() {
        let mut used = HashMap::new();
        for (name, expected) in [
            ("CON", "CON_"),
            ("con.TXT ", "con_.TXT"),
            ("Con_.txt.", "Con_ (1).txt"),
            ("prn.tar.gz", "prn_.tar.gz"),
            ("aux.ext", "aux_.ext"),
            ("NUL. ", "NUL_"),
            ("COM9", "COM9_"),
            ("Lpt1.log", "Lpt1_.log"),
            ("COM0", "COM0"),
            ("LPT10", "LPT10"),
            (" ... ", "_"),
            ("a?b.TXT", "a_b.TXT"),
            ("a_b (1).txt", "a_b (1).txt"),
            ("A:B.txt", "A_B (2).txt"),
            ("a*b.TXT", "a_b (3).TXT"),
        ] {
            assert_eq!(unique_name(name, &mut used), expected);
        }
    }

    #[test]
    fn enumerates_parents_first_and_skips_non_regular_entries() {
        let dir = FileAttributes {
            permissions: Some(0o040755),
            ..Default::default()
        };
        let file = FileAttributes {
            permissions: Some(0o100644),
            size: Some(7),
            ..Default::default()
        };
        let link = FileAttributes {
            permissions: Some(0o120777),
            ..Default::default()
        };
        let socket = FileAttributes {
            permissions: Some(0o140777),
            ..Default::default()
        };
        let mut entries = Entries::default();
        let mut roots = HashMap::new();
        entries
            .push("/a".into(), "", &mut roots, file.clone())
            .unwrap();
        entries
            .push("/A".into(), "", &mut roots, dir.clone())
            .unwrap();
        let (parent, relative) = entries.next_directory().unwrap();
        assert_eq!(parent, "/A");
        let mut children = HashMap::new();
        entries
            .push("/A/CON.".into(), &relative, &mut children, dir)
            .unwrap();
        entries
            .push("/A/link".into(), &relative, &mut children, link)
            .unwrap();
        entries
            .push("/A/socket".into(), &relative, &mut children, socket)
            .unwrap();
        entries
            .push("/A/a".into(), &relative, &mut children, file.clone())
            .unwrap();
        let (parent, relative) = entries.next_directory().unwrap();
        assert_eq!(parent, "/A/CON.");
        entries
            .push("/A/CON./a".into(), &relative, &mut HashMap::new(), file)
            .unwrap();
        assert!(entries.next_directory().is_none());
        let paths: Vec<&str> = entries.all.iter().map(|e| e.relative.as_str()).collect();
        assert_eq!(
            paths,
            ["a", "A (1)", r"A (1)\CON_", r"A (1)\a", r"A (1)\CON_\a"]
        );
    }

    #[test]
    fn rejects_entry_twenty_thousand_and_one() {
        let file = FileAttributes {
            permissions: Some(0o100644),
            size: Some(0),
            ..Default::default()
        };
        let mut entries = Entries::default();
        let mut roots = HashMap::new();
        for _ in 0..ENTRY_LIMIT {
            entries
                .push("/file".into(), "", &mut roots, file.clone())
                .unwrap();
        }
        assert_eq!(
            entries.push("/extra".into(), "", &mut roots, file),
            Err("too-many".into())
        );
    }
}
