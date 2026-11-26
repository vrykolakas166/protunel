# Changelog

What changed in each release of protunel, for the people using it. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions
follow [Semantic Versioning](https://semver.org/). Vietnamese:
[CHANGELOG.vi.md](CHANGELOG.vi.md). Releases before 0.10.0 are described on the
[GitHub releases page](https://github.com/vrykolakas166/protunel/releases).

## [Unreleased]

### Improvements
- **Ctrl+T** in the main window opens the terminal and hides the main window, in one step.
- Right-click a host in the terminal's sidebar, or a shell's pane, and choose **Edit host…** to change it without going back to the main window. Changing the connection of a host that is in use reconnects its shells.
- A **status bar** at the bottom of the main window: live traffic of every connected tunnel, and your version or a waiting update.
- **Close to tray** (Settings › General, on by default): turn it off and closing the main window quits protunel, after asking.
- The **tray menu** stays short with many tunnels: running tunnels first, then the 5 you used last, then **All tunnels** with one submenu per group. It also gets Open terminal, a Router switch and Disconnect all.
- **Rebuilt guided tours**: shorter, in the order you set things up (add a tunnel, sign in, jump host, groups, port forwards, then the Router). The terminal tour shows what to do first when no shell is open, and offers the part about panes and files once your first shell is open.
- Simple mode says what to do when the switch is off; on Linux it mentions the one-time browser setting from the start.
- The terminal's host sidebar can be **resized**: drag its right edge (double-click it to go back to the default width).

## [0.10.0] - 2026-11-24

### Highlights

#### Files of the server you are in
- **File panel per shell**: the folder icon on a pane's header (or **Ctrl+Shift+O**) opens that shell's server over SFTP, on the same connection. It starts in the shell's current folder when the prompt or the shell reports it.
- A floating panel you can keep open while you type: drag it anywhere or let it **snap to a corner** of its shell, resize from any edge, **maximize** with a double-click on its header. One panel per shell, and its header always says `user@host`.
- Browse, create, rename, delete (it counts what goes; large deletes ask for the name), copy, cut and paste, properties, filter.
- **Edit text files** up to 2 MB right there (Ctrl+S; if someone changed the file meanwhile you are asked first), view the end of big logs, preview images.
- **Upload** by dropping files or folders on the panel, **download** to Downloads, or **Download to folder…** (the arrow next to Download) which remembers where you saved last. Nothing is overwritten without asking; transfers keep running when the panel is closed.

#### Copy between servers
- **Drag rows** from one panel to another panel, or onto a folder. On the same server a drop moves (hold **Ctrl** to copy); onto another server it always copies. **Copy** in one panel and **Paste** in another works too.
- When server A can log in to server B with a key, the copy goes **straight from A to B** (rsync, or scp for a single file), checked against the host key protunel already trusts for B. Otherwise it passes through this computer, and the panel offers to type `ssh-copy-id` into A's shell for you (you press Enter) so the next copy is direct.

#### Drag files out to Windows
- On Windows, drag rows out of the window onto Explorer, the Desktop or any app that accepts files. The download starts at the drop, shows in Explorer's progress dialog and in the panel's queue, has no size limit, and can be cancelled from either side without leaving partial files.

#### Groups
- Put hosts in **groups**: the tunnel list and the terminal's host list show them as sections. Rename or ungroup from the section menu; open a whole group in one tiled tab. **Ctrl+click** a group header to collapse or expand every group.
- **Import from WinSCP** (Settings › Backup): pick `WinSCP.ini`, preview, import. Folders become groups, saved passwords go straight into the system vault, jump hosts are matched or created once. Host keys are not imported: you confirm each one on first connect, as always.

### Improvements
- Closing a pane, a tab or the terminal window while a file panel holds unsaved edits now asks first.
- The guided tours cover groups, WinSCP import and the file panel.
- Vietnamese text now uses the app's own fonts for every letter (accented letters used to fall back to a system font mid-word).
- File dialogs, the "not a protunel config" import error and the reconnect notification follow the app's language.
- Settings, known hosts and other app files are written atomically, so a crash mid-save can no longer leave them truncated.

### Fixes
- Importing a config where a jump host came in as a copy left its hosts pointing at the original jump host.
- Connecting the same tunnel from two places at once (router, tray, terminal) could start it twice.
- Saving settings from the main and terminal windows at nearly the same time could undo one of the changes.
- An unknown "Simple / Full" mode in a settings file or imported config is ignored instead of breaking the mode choice.
- SSH library updated for a security advisory (RUSTSEC-2026-0492).
