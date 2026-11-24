use std::ffi::c_void;
use std::mem::{offset_of, size_of, ManuallyDrop, MaybeUninit};
use std::ptr;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use russh_sftp::client::SftpSession;
use tauri::AppHandle;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use windows::core::{
    implement, AgileReference, Error, Interface, Ref, Result as ComResult, BOOL, HRESULT, PWSTR,
};
use windows::Win32::{
    Foundation::{
        GlobalFree, DATA_S_SAMEFORMATETC, DRAGDROP_S_CANCEL, DV_E_CLIPFORMAT, DV_E_DVASPECT,
        DV_E_DVTARGETDEVICE, DV_E_LINDEX, DV_E_TYMED, ERROR_CANCELLED, E_ABORT, E_NOTIMPL,
        E_OUTOFMEMORY, E_POINTER, OLE_E_ADVISENOTSUPPORTED, STG_E_ACCESSDENIED,
        STG_E_READFAULT, S_FALSE, S_OK,
    },
    System::{
        Com::{
            CoTaskMemAlloc, IAdviseSink, IBindCtx, IDataObject, IDataObject_Impl, IEnumFORMATETC,
            IEnumSTATDATA, ISequentialStream_Impl, IStream, IStream_Impl, DATADIR_GET,
            DVASPECT_CONTENT, FORMATETC, LOCKTYPE, STATFLAG, STATFLAG_DEFAULT, STATSTG, STGC,
            STGMEDIUM, STGMEDIUM_0, STGM_READ, STGTY_STREAM, STREAM_SEEK, STREAM_SEEK_CUR,
            TYMED_HGLOBAL, TYMED_ISTREAM,
        },
        DataExchange::RegisterClipboardFormatW,
        Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
        Ole::{DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE},
    },
    UI::Shell::{
        IDataObjectAsyncCapability, IDataObjectAsyncCapability_Impl, SHCreateStdEnumFmtEtc,
        CFSTR_FILECONTENTS, CFSTR_FILEDESCRIPTORW, CFSTR_PREFERREDDROPEFFECT, FILEDESCRIPTORW,
        FILEGROUPDESCRIPTORW,
    },
};

use crate::ssh::sftp::{self, Direction, Transfer, TransferState, CHUNK, PROGRESS_EVERY};

use super::entries::Entry;

const READ_AHEAD: usize = 32;

pub(super) struct Formats {
    descriptor: u16,
    contents: u16,
    preferred: u16,
}

impl Formats {
    pub(super) fn register() -> ComResult<Self> {
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

pub(super) fn make_data_object(
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
pub(super) struct Operation {
    async_mode: bool,
    pub(super) running: bool,
    pub(super) ended: bool,
    streams: Vec<Arc<DragTransfer>>,
}

pub(super) struct Extraction {
    pub(super) app: AppHandle,
    pub(super) tunnel: Uuid,
    pub(super) sftp: Arc<SftpSession>,
    pub(super) operation: Mutex<Operation>,
    pub(super) _keep_mta: std::sync::mpsc::Sender<()>,
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

    pub(super) fn finish(&self, result: HRESULT, effect: DROPEFFECT) {
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
