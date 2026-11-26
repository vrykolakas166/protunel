<p align="center">
  <img src="src-tauri/icons/128x128.png" alt="protunel icon" width="96">
</p>

<h1 align="center">protunel</h1>

<p align="center">
  Desktop SSH tunnel manager and terminal for Windows and Linux.
</p>

<p align="center">
  <a href="https://github.com/vrykolakas166/protunel/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/vrykolakas166/protunel?style=flat"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/vrykolakas166/protunel?style=flat"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20x86__64-lightgrey?style=flat">
</p>

protunel manages SSH tunnels for Windows and Linux (x86_64). Add a host, switch it on, and reach internal sites through it: the proxy router picks a tunnel per connection, and a tunnel can also expose its own local `socks5://127.0.0.1:<port>` proxy (tick "Enable local SOCKS5 proxy") for apps pointed straight at it. No PuTTY or plink. The same hosts open in a tabbed, split-pane SSH terminal with broadcast typing.

Contents: [Download](#download) | [Features](#features) | [Installation](#installation) | [Linux notes](#linux-notes) | [Proxy router](#proxy-router) | [Process capture](#process-capture) | [SSH terminal](#ssh-terminal) | [Export and import](#export-and-import) | [License](#license)

## Download

Get the latest build from the [Releases page](https://github.com/vrykolakas166/protunel/releases/latest).

| Platform | Package | Updates |
| --- | --- | --- |
| Windows | `.exe` installer or `.msi` | In-app |
| Arch Linux and derivatives | Signed pacman repo (one-line installer) | `pacman -Syu` |
| Debian / Ubuntu | `.deb` | Manual |
| Fedora / openSUSE | `.rpm` | Manual |
| Other Linux | AppImage | In-app |

## Features

### Tunnels

- Password, private-key or SSH-agent authentication (Pageant on Windows, `$SSH_AUTH_SOCK` on Linux).
- Per-tunnel SOCKS5 proxy and static local forwards (`-D`, `-L`).
- Jump tunnels: a tunnel connects through another tunnel's live session. Connecting the inner one dials the whole chain.
- Auto-reconnect with backoff, keepalive dead-peer detection, and local ports held across outages.
- Live per-tunnel stats, connect/disconnect all, search, clone and drag to reorder.
- Host groups, shown as sections in the tunnel list and the terminal; import sessions, folders and saved passwords from WinSCP.

### Proxy router

- One local SOCKS5 port. Ordered rules pick a tunnel per destination instead of per app.
- Process capture: launch any `.exe` with a hook DLL that forces its outbound TCP through the router, with no system proxy change.

### Terminal

- Separate window with tabs and drag-to-split panes.
- Broadcast typing to many servers at once.
- Watch many servers in one tab: tile evenly, sync scroll, new-output markers and output/silence alerts.
- File panel (SFTP) for the server of the shell you are in: browse, edit, upload and download.
- Reuses the tunnel's live session.

### Security

- TOFU host-key verification. Unknown keys prompt with the fingerprint, and mismatches are rejected rather than silently trusted. A known-hosts manager lets you review and revoke keys.
- Secrets (passwords, key passphrases) live in your OS vault, never in the app's own database. This is Windows Credential Manager, or the Secret Service (GNOME Keyring, KWallet) on Linux.
- Encrypted config export and import.
- Signed auto-updater.

### Interface

- 189 colour themes with hover preview, or follow Windows with your own light/dark pair.
- System tray toggles, hide-to-tray, single-instance and OS notifications.
- Guided tour.

## Installation

### Windows

Download `protunel_<version>_x64-setup.exe` (or the `.msi`) from [Releases](https://github.com/vrykolakas166/protunel/releases/latest) and run it. New versions are offered inside the app.

### Arch Linux and derivatives

```sh
curl -fsSL https://raw.githubusercontent.com/vrykolakas166/protunel/master/packaging/arch/install.sh | sudo bash
```

This adds protunel's signed package repo and installs the app. Find it in your app launcher. Updates arrive with your normal `sudo pacman -Syu`.

<details>
<summary>Install by hand</summary>

Packages and the repo database are signed with the repo key `017C5997B8FE5A79784BA2C29A38E414ECE95901` ([`packaging/arch/protunel-repo.asc`](packaging/arch/protunel-repo.asc)).

1. Trust the key:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/vrykolakas166/protunel/master/packaging/arch/protunel-repo.asc \
     | sudo pacman-key --add -
   sudo pacman-key --lsign-key 017C5997B8FE5A79784BA2C29A38E414ECE95901
   ```

2. Create `/etc/pacman.d/protunel.conf`:

   ```ini
   [protunel]
   SigLevel = Required
   Server = https://github.com/vrykolakas166/protunel/releases/download/pacman-repo
   ```

   Then add this line at the end of `/etc/pacman.conf`:

   ```ini
   Include = /etc/pacman.d/protunel.conf
   ```

3. Install the package:

   ```sh
   sudo pacman -Syu protunel-bin
   ```

</details>

<details>
<summary>Uninstall</summary>

This removes the app, the repo entry and the key.

```sh
curl -fsSL https://raw.githubusercontent.com/vrykolakas166/protunel/master/packaging/arch/install.sh | sudo bash -s -- --uninstall
```

</details>

<details>
<summary>If the repo blocks pacman -Syu</summary>

If the repo is unreachable and blocks `sudo pacman -Syu`, switch it off:

```sh
curl -fsSL https://raw.githubusercontent.com/vrykolakas166/protunel/master/packaging/arch/install.sh | sudo bash -s -- --disable
```

Turn it back on with `--enable` instead of `--disable`.

</details>

### Debian, Ubuntu and derivatives

Download `protunel_<version>_amd64.deb` from Releases, then:

```sh
sudo apt install ./protunel_<version>_amd64.deb
```

<details>
<summary>Updates</summary>

There are no automatic updates. Download the new `.deb` to upgrade, or use the AppImage, which updates itself.

</details>

### Fedora, openSUSE and derivatives

Download `protunel-<version>-1.x86_64.rpm` from Releases, then:

```sh
sudo dnf install ./protunel-<version>-1.x86_64.rpm     # Fedora
sudo zypper install ./protunel-<version>-1.x86_64.rpm  # openSUSE
```

<details>
<summary>Updates</summary>

There are no automatic updates. Download the new `.rpm` to upgrade, or use the AppImage.

</details>

### Any Linux: AppImage

Download `protunel_<version>_amd64.AppImage` (needs `fuse2`), then:

```sh
chmod +x protunel_<version>_amd64.AppImage
./protunel_<version>_amd64.AppImage
```

<details>
<summary>Updates and caveats</summary>

The AppImage updates itself from inside the app. It bundles its own WebKit, which can misbehave on rolling distros. On Arch, prefer the package above.

</details>

## Linux notes

- Vault: needs a running Secret Service (`gnome-keyring`, or KeePassXC with Secret Service on). The app checks at startup and shows the fix if it is missing.
- Tray: StatusNotifierItem. Works on KDE, XFCE and waybar's `tray` module. GNOME needs the AppIndicator extension. Left-click toggles the window.
- Proxy for other apps: there is no system-wide proxy setting to write, so the router panel provides ready-to-paste lines instead. These are `env` lines for `hyprland.conf` (or `export` for a shell profile), a Chromium flag, and Firefox steps, all filled in with the router port.
- Browsers: point them at `http://127.0.0.1:1090/protunel.pac` (the router port, which answers this one URL itself). While protunel runs they follow the router rules; once it is closed they connect directly, so nothing needs switching back. Firefox takes it under Network Settings, Chromium-based browsers via `--proxy-pac-url`. They do not accept a `file://` PAC.
- Hyprland: ignores XDG autostart. Settings shows the `exec-once` line when start-at-login is on. On the NVIDIA driver the app disables WebKit's DMA-BUF renderer itself, which otherwise draws a blank window.
- Laggy window on Wayland: if the log shows `Disabled hardware acceleration because GTK failed to initialize GL: No available configurations for the given pixel format`, GTK3 found no usable EGL config, so WebKit draws everything on the CPU. Running through XWayland restores acceleration. Use `exec-once = env GDK_BACKEND=x11 protunel` in `hyprland.conf`, or copy protunel's `.desktop` file to `~/.local/share/applications/` and set `Exec=env GDK_BACKEND=x11 protunel`.
- Process capture and the automatic system-proxy toggle are Windows-only.

## Proxy router

One SOCKS5 port on `127.0.0.1`. Rules are evaluated top to bottom, and the first enabled match wins.

| Kind | Example | Matches |
| --- | --- | --- |
| Host wildcard | `*.corp.example.com` | Domain and subdomains |
| Host regex | `\.internal$` | Unanchored, case-insensitive |
| IP CIDR | `10.0.0.0/8` | Literal IPs, and hostnames when local resolution is on |
| Everything | n/a | Catch-all |

Each rule may require a destination port and resolves to tunnel, direct (bypass tunnels) or block. Unmatched traffic takes the default action. A rule targeting a down tunnel connects it on demand and holds the request until the session authenticates.

Point apps at the router manually (`curl --socks5-hostname 127.0.0.1:1090 ...`), or tick "Point the Windows system proxy here". In that case the app serves a PAC script and sets only WinINET's `AutoConfigURL`. It restores the setting on stop, and replays the backup on next startup after a crash. PAC is required because Windows' plain `ProxyServer` setting means SOCKS4, which the listener refuses. The script forwards everything (minus the bypass list) with no `DIRECT` fallback, so a stopped router fails closed.

The router port also serves a script at `http://127.0.0.1:<port>/protunel.pac`, for browsers configured by hand (mainly on Linux). That copy ends `; DIRECT`: with protunel closed the SOCKS port refuses connections and the browser connects directly, so it behaves as if no proxy were set. Browsers keep a failed proxy marked bad for a while (Firefox: `network.proxy.failover_timeout`, 30 minutes by default), so after starting protunel again, lower that value or restart the browser to reach internal sites right away. While protunel is closed, any local program could bind that port and serve its own PAC; on a machine shared with other users, prefer the manual SOCKS setting.

The panel also has a rule test box and a decision log of recent connections. The router only binds `127.0.0.1`.

### DNS

Hostnames are still sent unresolved to the SSH server. The name goes down the tunnel and the server resolves it (`ssh -D` behavior), so internal names work. Use `--socks5-hostname`, not `--socks5`.

The router is the one place that resolves locally. IP and CIDR rules need an address, so with the "Resolve hostnames locally so IP/CIDR rules can match" setting on (default), the router does one lookup per connection, only when it reaches such a rule, and only to match it. The connection itself still carries the name. With the setting off, CIDR rules never match hostnames. That lookup goes to your local DNS, so it can reveal the name there.

## Process capture

Windows only. For apps that ignore proxy settings. Capture launches the target with a hook DLL injected before its first instruction. The hook redirects `connect`, `WSAConnect`, `ConnectEx` and `getaddrinfo` to the router's SOCKS5 port, with hostnames preserved.

Capture fails closed: if the hook is not installed before the main thread runs, the process is killed rather than resumed unhooked. Captures survive an unclean shutdown and are re-adopted on restart (PID reuse is guarded by an exe-path check).

## SSH terminal

The Terminal button in the header opens a separate window (**Ctrl+T** opens it and hides the main window). Every tunnel is a host there (add one with SOCKS off if you only want a shell); right-click a host or a pane for **Edit host…**. Drag the sidebar's right edge to resize it.

A terminal opens a PTY channel on the tunnel's existing session, connecting it and its jump chain if needed. It therefore shares credentials, host-key checks and the connection itself. If the session drops, press Enter to reconnect.

- Tabs and split panes: drag a host from the sidebar tree, a tab, or a pane header onto any edge of a pane to split it (a preview shows where it lands). Drop on the tab bar for a new tab. Moving a pane never restarts its shell. Drag dividers to resize, double-click to even them out.
- Broadcast: type into every pane of a tab at once, with per-pane opt-out. Multi-line pastes to several servers ask first. It pauses while a pane is zoomed.
- Several servers in one tab: pick hosts in the sidebar's select mode (or Ctrl/Shift+click), or right-click a jump host for "open with its children", and they open as one tiled tab with broadcast off.
- Layout menu: tile evenly (Ctrl+Shift+G) or equalize splits, each with a 5 s Undo, and sync scroll, so scrolling one pane scrolls the others to the same place.
- Watching: a pane you are not looking at gets a hollow ring when new output starts after a quiet spell. Right-click a pane header to be notified on output or after 30 s of silence; a fired alert shows as an amber bell. Notifications name the host, never the output.
- Optional dimming of unfocused panes (Settings › Terminal).
- xterm.js with WebGL rendering. Mouse apps (htop, mc, vim) work.
- Echo latency and throughput are shown in the footer.

| Keys | Action |
| --- | --- |
| Ctrl+C | Always SIGINT |
| Select text / Ctrl+Shift+C | Copy |
| Ctrl+Shift+V / right-click | Paste |
| Ctrl+Shift+D / Ctrl+Shift+E | Split right / down with the same host |
| Alt+arrows | Move focus between panes |
| Ctrl+Shift+Z | Zoom pane |
| Ctrl+Shift+G | Tile panes evenly (press again to undo) |
| Ctrl+Shift+B | Toggle broadcast |
| Ctrl+Shift+W | Close pane |
| Ctrl+Shift+O | File panel of this shell (again: back to the shell) |
| Ctrl+Shift+K | Find host |
| Ctrl+Tab, Ctrl+1 to Ctrl+9 | Switch tab |

Shortcuts stay off plain Ctrl+letter, which belongs to the shell.

### File panel

The folder icon on a pane's header (or the toolbar, or Ctrl+Shift+O) opens the files of that shell's server over SFTP on the same session. It opens in the shell's folder when the prompt shows it (`user@host:/path$`) or the shell reports it (OSC 7), otherwise in the login folder.

- A floating panel per shell: keep typing in the shell while it is open. Drag its header anywhere, or let it snap to a corner of its shell; resize from any edge or corner; maximize with its button or a double-click on the header. Each panel stays bound to the shell that opened it, and its header shows `user@host` so files never go to the wrong server.
- Create, rename, delete, copy/cut/paste, properties, and a filter. Deleting a folder says how many files go; large deletes ask for the name. Servers have no trash.
- Text files up to 2 MB open in an editor (Ctrl+S saves; if someone changed the file meanwhile you are asked before overwriting). Bigger logs: view the last 1 MB. Images preview up to 10 MB. Anything else: download, or open a temporary copy with the system app.
- Upload: drop files or folders from your file manager onto the panel (it shows where they will land), or use the upload button. Existing names are skipped unless you choose Overwrite.
- Download goes to your Downloads folder and never overwrites a local file; "Download to folder…" (the arrow next to Download, or the right-click menu) asks where and remembers the folder. Transfers keep running when the panel is closed (see the footer).
- Drag rows between panels or onto a folder row. On the same server a drop moves (hold Ctrl to copy). Onto another server it always copies, and Copy in one panel then Paste in another does the same. The copy goes straight from server A to server B when A can log in to B with a key (rsync, or scp); otherwise it passes through this computer, and the panel offers to type `ssh-copy-id` into A's shell (you press Enter) so the next copy is direct.
- Windows: drag rows out of the window onto Explorer, the Desktop or any app that takes files. The copy starts at the drop, shows in Explorer's progress dialog and in the panel's queue, and can be cancelled from either.
- You act as the SSH user: no sudo.

| Keys (in the panel) | Action |
| --- | --- |
| Enter / Backspace | Open / up one folder |
| F2, Del | Rename, delete |
| Ctrl+C / Ctrl+X / Ctrl+V | Copy, cut, paste |
| Ctrl+Shift+N | New folder |
| Alt+Enter | Properties |
| Ctrl+L, Ctrl+F | Type a path, filter |
| Esc | Step back; closes the panel last |

## Export and import

Settings, then Export / import config, writes one JSON file: tunnels, forwards, router config and rules, settings (including theme) and known hosts. Terminal hosts are tunnels, so they are included. Tunnels are written in display order, and new ones are imported in that order.

Secrets are handled separately. With a blank passphrase, passwords and key passphrases are not written. They stay in the OS vault, so the file is safe to share. With a passphrase, they go in a sealed block: Argon2id derives the key, AES-256-GCM seals it, and each export uses a fresh salt and nonce. There is no recovery if the passphrase is forgotten.

Import shows a preview and is section-scoped:

- Tunnels match by id (update in place) or by name. Jump hosts imported under a new id take the hosts that go through them along. On a name conflict you can replace the tunnel or import it alongside as `... (imported)`.
- Router rules replace the existing list rather than merge. Tunnel targets are rewritten to follow any re-id'd tunnel.
- Known hosts merge, and your existing entries win (TOFU).

### From WinSCP

Settings › Backup › Import from WinSCP reads a `WinSCP.ini` (WinSCP: Tools › Export/Backup configuration). Session folders become groups and WinSCP tunnels become jump hosts, matched to hosts you already have when the address and user agree. Each session's remote directory is kept as a bookmark. The preview shows which sessions are new, which are already here (skip, or only move them into the folder's group), and names that don't match where they connect. Saved passwords go straight into the OS vault and never reach the window. Host keys are not imported: each server is still confirmed on first connect. A configuration protected by a WinSCP master password can't be read. Delete the exported file afterwards, since anyone holding it can read every saved password.

## License

[GPL-3.0](LICENSE)
