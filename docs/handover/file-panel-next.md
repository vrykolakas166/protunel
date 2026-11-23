# File panel batch: manual test checklist (Windows)

The implementation is done. What is left is testing it by hand on a Windows
10/11 machine, with a release build too (`bun run tauri build`). Use a Linux
server (ideally two, A and B) reachable through protunel tunnels.

Never run `cargo clean -p protunel`. Commit only when the user asks.

## 1. Drag-out to Explorer (Windows only)

1. One small text file to the Desktop: content identical (compare a hash).
2. One 5+ GB file to a folder: Explorer shows real progress, protunel stays
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
7. Several rows selected (mixed files and folders) into one drop.
8. Drop into Outlook (attach) and into a browser `<input type=file>` drop zone.
9. Drag out and back onto protunel itself: nothing uploads.
10. Esc during the drag: nothing happens.
11. A name longer than MAX_PATH, and a tree over the entry cap: refused with a
    message, nothing half-done.
12. A Linux build still compiles (`cargo check` on Linux, or CI), and the UI
    there never starts an OS drag.

## 2. Server to server (drag between panels, or Copy then Paste)

- Dragging between panels of different servers always copies; the original is
  never deleted. Cut never crosses servers.
- The drop zone names the action ("Copy to user@B, /path").
- Same server: a drop moves, Ctrl copies.
- **rsync:** A has rsync and can log in to B without a prompt. Copy a folder:
  the queue shows the direct route with progress; existing names are kept
  (`--ignore-existing`); Cancel kills the remote process.
- **scp, single file:** A without rsync. Copy one file: it goes direct; after
  Cancel, the partial target is removed.
- **Relay and the `ssh-copy-id` hint:** A cannot log in to B by itself. The
  copy goes through protunel ("via this computer", speed shown) and the hint
  "Faster: let A log in to B" appears. Its button types
  `ssh-copy-id -p PORT user@B` into A's shell only, **without pressing
  Enter** (with `ssh-keygen -t ed25519` first if A has no key). Run it by hand,
  copy again: the route is now direct.
- **Host-key pin:** make B's name resolve to a different host from A's point
  of view (for example an `/etc/hosts` entry on A). The direct probe must
  fail (`StrictHostKeyChecking=yes`) and the copy must fall back to the relay,
  never copy to the wrong machine.
- Existing names are skipped on relay, with Overwrite offered in the queue.
- Queue rows show "A to B" and the route taken.

## 3. Download to folder

- "Download to folder…" next to Download opens a Rust-side folder dialog,
  remembers the last folder, and saves there without overwriting
  (`name (1).ext`).
- Works on Linux too (it is the drag-out substitute there).

## 4. Unsaved edits

- Open a file in the editor, change it, then close the panel, or close its
  pane/tab: a Save / Discard / Cancel question appears; Cancel keeps
  everything, Save writes then closes, Discard closes without writing.
- Panel close button and Esc follow the same rule.

## 5. Workspace tabs

- A tab opened from a workspace is named after the workspace.
- Opening the same workspace again focuses the existing tab instead of
  duplicating it.
- The save button shows a dot after a layout change, and "Save changes"
  writes the open linked tabs back.

## Done means

- Everything above passes on Windows 10/11.
- `CLAUDE.md` "File panel" and the README file panel section match what the
  app does (drag-out is Windows only; no change in behaviour on Linux).
