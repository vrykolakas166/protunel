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

protunel manages SSH tunnels for Windows and Linux (x86_64). Add a host, switch it on, and get a local `socks5://127.0.0.1:<port>` proxy tunneled through SSH, with no PuTTY or plink. The same hosts open in a tabbed, split-pane SSH terminal with broadcast typing.

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

### Proxy router

- One local SOCKS5 port. Ordered rules pick a tunnel per destination instead of per app.
- Process capture: launch any `.exe` with a hook DLL that forces its outbound TCP through the router, with no system proxy change.

### Terminal

- Separate window with tabs and drag-to-split panes.
- Broadcast typing to many servers at once.
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

Hostnames are not resolved locally before SSH. The name goes down the tunnel and the server resolves it (`ssh -D` behavior), so internal names work and DNS does not leak. Use `--socks5-hostname`, not `--socks5`.

IP and CIDR rules need an address. The "Resolve hostnames locally so IP/CIDR rules can match" setting (default on) does one lookup per connection, for matching only.

## Process capture

Windows only. For apps that ignore proxy settings. Capture launches the target with a hook DLL injected before its first instruction. The hook redirects `connect`, `WSAConnect`, `ConnectEx` and `getaddrinfo` to the router's SOCKS5 port, with hostnames preserved.

Capture fails closed: if the hook is not installed before the main thread runs, the process is killed rather than resumed unhooked. Captures survive an unclean shutdown and are re-adopted on restart (PID reuse is guarded by an exe-path check).

## SSH terminal

The Terminal button in the header opens a separate window. Every tunnel is a host there (add one with SOCKS off if you only want a shell).

A terminal opens a PTY channel on the tunnel's existing session, connecting it and its jump chain if needed. It therefore shares credentials, host-key checks and the connection itself. If the session drops, press Enter to reconnect.

- Tabs and split panes: drag a host from the sidebar tree, a tab, or a pane header onto any edge of a pane to split it (a preview shows where it lands). Drop on the tab bar for a new tab. Moving a pane never restarts its shell. Drag dividers to resize, double-click to even them out.
- Broadcast: type into every pane of a tab at once, with per-pane opt-out. Multi-line pastes to several servers ask first.
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
| Ctrl+Shift+B | Toggle broadcast |
| Ctrl+Shift+W | Close pane |
| Ctrl+Shift+K | Find host |
| Ctrl+Tab, Ctrl+1 to Ctrl+9 | Switch tab |

Shortcuts stay off plain Ctrl+letter, which belongs to the shell.

## Export and import

Settings, then Export / import config, writes one JSON file: tunnels, forwards, router config and rules, settings (including theme) and known hosts. Terminal hosts are tunnels, so they are included. Tunnels are written in display order, and new ones are imported in that order.

Secrets are handled separately. With a blank passphrase, passwords and key passphrases are not written. They stay in the OS vault, so the file is safe to share. With a passphrase, they go in a sealed block: Argon2id derives the key, AES-256-GCM seals it, and each export uses a fresh salt and nonce. There is no recovery if the passphrase is forgotten.

Import shows a preview and is section-scoped:

- Tunnels match by id (update in place) or by name. On a name conflict you can replace the tunnel or import it alongside as `... (imported)`.
- Router rules replace the existing list rather than merge. Tunnel targets are rewritten to follow any re-id'd tunnel.
- Known hosts merge, and your existing entries win (TOFU).

## License

[GPL-3.0](LICENSE)
