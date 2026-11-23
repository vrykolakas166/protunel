# Handover: drag files from the file panel to Windows Explorer

For Claude Code / Codex working on a **Windows** machine. All remaining work
of this batch now continues on Windows, not only drag-out. Do it in the order
under "Remaining work, in order" at the end of this file; this first part
details step 3, drag-out.

## Read first

1. `CLAUDE.md`: the whole file, but especially:
   - **"File panel"**: the SFTP popup this work extends.
   - **"Adding or changing an IPC command"**: 4 places must agree.
   - **"Tray and window"** and **Frontend conventions**: i18n `en` + `vi` with
     the Vietnamese glossary; semantic colour tokens only.
2. `src-tauri/src/ssh/sftp.rs`:
   - `sftp_for` (cached SFTP channel per tunnel session).
   - The transfer queue (`Transfer`, `spawn`, `publish`, `FILE_TRANSFER_EVENT`).
   - `download_file` (the read loop to copy).
3. `src/terminal/files/FilePanel.tsx`: row selection, `targets()`, and the
   in-app row drag if it has landed by the time you pull (see "Prerequisite").

Verification commands are in `CLAUDE.md` → Commands. Never run
`cargo clean -p protunel`. Commit only when the user asks; end commit messages
with the `Co-Authored-By` line the session gives you.

## Goal (decided with the user)

Drag one or more rows, files or folders, out of a file panel and drop them in
Explorer, on the Desktop, or in any app that accepts virtual files (Outlook,
browser upload fields…).

- **Drop first, download after.** The data is pulled from the server while
  Explorer copies.
- **No size limit.** Nothing is staged in a temp folder first.
- **Cancellable**, from Explorer's copy dialog and from protunel's transfer
  queue.
- **No junk left behind** after a cancel or error: Explorer deletes its
  partial file; protunel closes the SFTP handle.
- The app stays responsive while gigabytes copy.

Linux is **out of scope**. The user decided Linux gets a "Download to
folder…" button instead (step 2 below). On non-Windows
builds this feature must not exist: the command returns `"unsupported"`, and
the UI never starts an OS drag (`src/platform.ts` `isWindows`).

## Design

### Mechanism: OLE virtual files

Use the shell "virtual file" data formats:

- `CFSTR_FILEDESCRIPTORW` (`"FileGroupDescriptorW"`): a `FILEGROUPDESCRIPTORW`
  with one `FILEDESCRIPTORW` per entry.
  - `cFileName` is the path **relative to the drop**, with `\` separators.
    Folders get their own entries, parents before children.
  - `dwFlags = FD_ATTRIBUTES | FD_FILESIZE | FD_WRITESTIME | FD_PROGRESSUI | FD_UNICODE`.
  - Set `dwFileAttributes` to `FILE_ATTRIBUTE_DIRECTORY` for folders and
    `FILE_ATTRIBUTE_NORMAL` for files.
  - Set `nFileSizeHigh/Low` from SFTP `size`, so Explorer's progress bar and
    free-space check are right.
  - Set `ftLastWriteTime` from SFTP `mtime` (Unix seconds → FILETIME).
- `CFSTR_FILECONTENTS` (`"FileContents"`), `lindex` = descriptor index: a
  `STGMEDIUM` with `TYMED_ISTREAM`, holding our own `IStream` for that file.
  Folders have no contents.
- `CFSTR_PREFERREDDROPEFFECT` = `DROPEFFECT_COPY`. It is never a move: the
  server copy is never deleted.
- Register the format names with `RegisterClipboardFormatW`.

### Async extraction (required, so the UI does not freeze)

Implement `IDataObjectAsyncCapability`:
- `SetAsyncMode(TRUE)` up front.
- `GetAsyncMode` returns TRUE.
- `StartOperation` and `EndOperation` track the operation;
  `EndOperation` receives the final `HRESULT` and the effect.

Explorer then copies on its own background thread, and `DoDragDrop` returns as
soon as the drop happens. Without this, the window's message loop is blocked
until the copy finishes.

### Threads

- `DoDragDrop` must run on the **main (UI) thread**, which owns the message
  loop. Tauri/tao already calls `OleInitialize` there
  (`tao/src/platform_impl/windows/window.rs`). Use
  `app.run_on_main_thread(...)`.
- The mouse button must still be down when `DoDragDrop` starts. Call it while
  the user is still holding the button (see "Frontend").
- `IStream::Read` is called on Explorer's thread and must **block** until
  data is available. Bridge to tokio like this:
  - Per file, a tokio task opens the SFTP file (`sftp_for(app, tunnel)` →
    `open`) and reads `CHUNK`s (256 KiB) into a bounded channel. Capacity
    about 32, i.e. ~8 MB read-ahead, which keeps throughput up over high-latency
    VPNs.
  - `Read` does a blocking receive from that channel
    (`std::sync::mpsc::Receiver` or `tokio::sync::mpsc::Receiver::blocking_recv`),
    fills Explorer's buffer, and keeps any leftover for the next `Read`.
  - At EOF: return the short count with `S_OK` (or `S_FALSE` at 0 bytes).
  - Start the reader task lazily, on the first `GetData(FileContents, i)`,
    not for every file at drag start.
- Implement `IStream::Stat`, returning `cbSize` (and the name with
  `STATFLAG_DEFAULT`); some targets ask for it. `Seek` only needs
  `STREAM_SEEK_CUR` with offset 0 (tell); return `E_NOTIMPL` for anything
  else, unless a real target turns out to need it.

### Enumeration before the drag

When the drag leaves the window, protunel must list the dragged folders
recursively before calling `DoDragDrop`, because the descriptor needs every
entry up front.

- Do not follow symlinks; skip special files. Follow the existing walkers in
  `sftp.rs`: `count`, `remote_size`.
- Cap it, for example at 20 000 entries. Above the cap, refuse with a message
  telling the user to use Download instead.
- Paths longer than MAX_PATH: a relative `cFileName` longer than 259 UTF-16
  units cannot be described. Refuse the drag and name the offending path. Do
  not silently truncate it.
- While listing, the panel shows "Preparing…" on the dragged rows. If listing
  takes too long, the user may already have let go. In that case cancel and
  do nothing (check `GetAsyncKeyState(VK_LBUTTON)` before `DoDragDrop`).

### `IDropSource`

- `QueryContinueDrag`: Esc → `DRAGDROP_S_CANCEL`; button released →
  `DRAGDROP_S_DROP`.
- `GiveFeedback`: `DRAGDROP_S_USEDEFAULTCURSORS`.
- A drag image is optional (`IDragSourceHelper::InitializeFromWindow` or a
  plain bitmap). Not required for v1.

### Transfer queue integration

Each dropped file appears in protunel's queue as a `Transfer`:
- `direction: "download"`, with `local_path` set to something like
  `"Explorer"` (we never learn the real target path).
- Progress is counted from the bytes `Read` hands to Explorer.

Cancel:
- Cancel in protunel → the next `Read` returns `E_ABORT`. Explorer stops and
  deletes its partial file.
- Cancel in Explorer → Explorer releases the stream. The stream's `Drop`
  cancels the reader task and closes the SFTP handle; mark the transfer
  `cancelled`.
- An error mid-file (VPN drop, permission denied) → `Read` returns `E_FAIL`
  (or `STG_E_READFAULT`); mark the transfer `failed` with the error text.

`EndOperation` gives the final result; use it to mark anything still running.

### IPC

Follow `CLAUDE.md` "Adding or changing an IPC command":
- `commands/files.rs` gets
  `files_drag_out(app, window, tunnel_id: Uuid, paths: Vec<String>) -> Result<(), String>`,
  with a `#[cfg(not(windows))]` body that returns `Err("unsupported")`.
- Register it in `lib.rs`.
- Add it to `src/api.ts` (`filesDragOut`).
- Add types to `src/types.ts` only if new types cross the boundary.

Put the Windows code in its own module, e.g. `src-tauri/src/ssh/drag_out.rs`
behind `#[cfg(windows)]`. Add the `windows` crate features it needs under
`[target.'cfg(windows)'.dependencies]`; keep the version in step with
`windows-core = "0.62.2"` already there. Likely features include
`Win32_System_Com`, `Win32_System_Com_StructuredStorage`, `Win32_System_Ole`,
`Win32_UI_Shell`, `Win32_System_Memory`, `Win32_Storage_FileSystem`,
`Win32_UI_Input_KeyboardAndMouse`. Implement the COM objects with
`#[windows::core::implement(...)]`.

### Frontend

- **Prerequisite.** Step 1 adds in-app row drag: drag rows from
  one panel to another panel, or to a folder row. If that has landed when you
  pull, hook into it. If not, add a minimal pointer drag on rows: start after
  a 4 px move, with a small ghost label "N items", following
  `src/terminal/useDragDrop.ts` style. Never use HTML5 drag-and-drop.
- **Trigger.** While a row drag is in progress, the pointer leaves the window
  (`clientX/Y` outside `0..innerWidth/innerHeight`; the panel holds pointer
  capture, so moves outside still arrive). Then:
  1. Release pointer capture.
  2. Cancel the in-app drag.
  3. Call `filesDragOut(tunnelId, paths)`.
  4. Show "Preparing…" on the rows until it resolves.
- Windows only (`isWindows`). Elsewhere, leaving the window just ends the
  drag with nothing dropped.
- A drop back onto protunel's own window is a no-op: Tauri's drop handler
  only gets real paths, and there are none here. Check this does not upload
  anything.
- Strings go in `src/locales/{en,vi}/terminal.json` under `files.*`:
  - "Preparing…"
  - "Too many items to drag (use Download)"
  - "Path too long for Windows: …"
  - "Explorer" as the transfer target

  Vietnamese follows the glossary in `CLAUDE.md`; keep "Explorer" in English.

## Test plan (Windows, release build too: `bun run tauri build`)

1. One small text file → Desktop: content identical (compare a hash).
2. One 5+ GB file → a folder: Explorer shows real progress, protunel stays
   responsive (type in a shell meanwhile), memory stays flat (read-ahead
   bounded).
3. A folder tree with subfolders, empty folders and a symlink: the tree is
   recreated, the symlink is skipped, mtimes are kept.
4. Cancel in Explorer's dialog halfway: no partial file left; the protunel
   queue says Cancelled; the SFTP handle is closed (copy again at once and it
   works).
5. Cancel from protunel's queue halfway: Explorer reports the error; no
   partial file left.
6. Disconnect the VPN or kill the tunnel mid-copy: clear failure, no partial
   file, queue says Failed.
7. Several rows selected (mixed files and folders) → one drop.
8. Drop into Outlook (attach) and into a browser `<input type=file>` drop zone.
9. Drag out and back onto protunel itself: nothing uploads.
10. Esc during the drag: nothing happens.
11. Name longer than MAX_PATH, and a tree over the cap: refused with a
    message, nothing half-done.
12. A Linux build still compiles (`cargo check` on Linux, or CI), and the UI
    there never starts an OS drag.

Run the verification commands in `CLAUDE.md`. Have Codex review the diff
(read-only) before handing it to the user.

## Done means

- All of the test plan passes on Windows 10/11.
- `CLAUDE.md` "File panel" gets a short paragraph on drag-out (formats,
  async, threads, cancel).
- The README file panel section mentions it (Windows only).
- No change in behaviour on Linux.

## Decisions already taken (do not reopen)

- **Server → server in the app**:
  - Dragging between panels of different servers always **copies**; the
    original is never deleted (no cross-server move in this version).
  - Within one server, a drop moves; Ctrl copies.
  - Copy in A's panel, then Paste in B's panel, takes the same path as a
    drag. Cut never crosses servers: the user deletes on A by hand.
  - Copy goes **direct A → B** when a check on A
    (`ssh -o BatchMode=yes -o StrictHostKeyChecking=yes … true`) passes. That
    happens automatically, with no prompt.
  - Otherwise the data relays through protunel, with a hint and a button that
    types `ssh-copy-id …` into A's shell **without pressing Enter**.
    protunel never handles passwords or keys for this.
- Guide tours and "What's new" are updated once at the end of the batch, not
  per feature.

## Remaining work, in order

Each step: tests for pure helpers in `tests/`, the verification commands from
`CLAUDE.md`, a read-only Codex review of the diff, then hand over to the user
to test. Commit only when the user asks.

1. **Server → server in the app (all platforms).**
   - Pointer drag of selected rows. Start it after a 4 px move; show a ghost
     label "N items". Never use HTML5 drag-and-drop. Drop targets:
     - another panel's list, which means its current folder;
     - a folder row, in any panel including the source panel.
   - The drop zone names the action: "Copy to user@B → /path" or "Move to …".
   - Same tunnel: a drop moves (`sftp::rename`); Ctrl copies (`cp -a -n`).
     Use the existing `files_paste`.
   - Different tunnel: always a copy, never a move. Also let Copy in A, then
     Paste in B, work. The module-level `clipboard` in `FilePanel.tsx` is
     limited to one tunnel today (`canPaste`). Keep Cut limited to the same
     tunnel.
   - Transfer, chosen automatically with no prompt:
     - **Direct.** Run a probe on A over `exec`:
       `ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=yes -p PORT user@B true`.
       Use B's host, port and user as protunel knows them, and pass every
       argument through `sftp::quote`. Cache the result per A→B pair for the
       session. When the probe passes, run the copy on A:
       `rsync -a --ignore-existing --info=progress2` when A has rsync (parse
       its progress), otherwise `scp -rp` (no progress). Cancel kills the
       remote process and closes the channel. After scp is stopped, remove
       its partial target.
     - **Relay.** When the probe fails, Rust reads from A and writes to B with
       the existing part-file and rename scheme. Progress and Cancel work.
       Existing names are skipped, with Overwrite offered in the queue.
       - The queue row shows "via this computer · speed".
       - Show a hint, "Faster: let A log in to B", with a button. The button
         types `ssh-copy-id -p PORT user@B` into A's shell. If A has no key
         yet, prefix it with `ssh-keygen -t ed25519`. The button must **not
         press Enter**: use `terminalWrite` to that pane only.
       - protunel never sees passwords or keys for this.
   - Queue rows show "A → B" and which route the copy took. New directions
     go into `sftp::Direction` and `src/types.ts`.
2. **"Download to folder…"** next to Download. A Rust-side folder dialog
   (like `files_pick_upload`); remember the last folder chosen. This is the
   only drag-out substitute on Linux.
3. **Drag-out to Explorer (Windows):** this document, above.
4. **End of batch, once:** update both guided tours (`TourGuide` main window,
   `TerminalTour`) and "What's new". Cover:
   - groups;
   - Ctrl+click on a group header collapses or expands every group;
   - WinSCP import (Settings › Backup);
   - the file panel: header folder icon `data-tour="term-files"`,
     Ctrl+Shift+O, one per shell, snap/resize/maximize, server-to-server
     copy, drag-out.
5. **Known gap, ask the user:** closing a pane whose file panel has an
   unsaved editor draft discards the draft without a prompt.
