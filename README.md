# protunel

Desktop SSH tunnel manager for Windows and Linux (x86_64). Add a host, flip a switch, get a local
`socks5://127.0.0.1:<port>` proxy tunneled through SSH — no PuTTY/plink. The same
hosts open in a tabbed, split-pane SSH terminal with broadcast typing.
[Tauri](https://tauri.app) + React/TypeScript, embedded Rust SSH client.

## Features

- Password, private-key, or SSH-agent auth (Pageant on Windows, `$SSH_AUTH_SOCK` on Linux)
- Per-tunnel SOCKS5 proxy and static local forwards (`-D`, `-L`)
- **Proxy router** — one local SOCKS5 port, ordered rules pick a tunnel per
  *destination* instead of per app
- **Process capture** — launch any `.exe` with a hook DLL that forces its
  outbound TCP through the router, no system proxy change
- **Jump tunnels** — a tunnel connects through another tunnel's live session;
  connecting the inner one dials the whole chain
- **SSH terminal** — its own window, tabs and drag-to-split panes, broadcast
  typing to many servers at once; reuses the tunnel's live session
- Auto-reconnect with backoff, keepalive dead-peer detection, local ports held
  across outages
- TOFU host-key verification — unknown keys prompt with fingerprint; mismatches
  rejected, not silently trusted. Known-hosts manager to review/revoke
- Live per-tunnel stats, connect/disconnect all, search, clone, drag to reorder
- System tray toggles, hide-to-tray, single-instance, OS notifications
- Encrypted config export/import
- 189 colour themes with hover preview, or follow Windows with your own
  light/dark pair
- Guided tour, signed auto-updater

Secrets (passwords, key passphrases) live in the OS vault via `keyring` —
Windows Credential Manager, or the Secret Service (GNOME Keyring, KWallet) on
Linux — never in SQLite.

## Linux

Install the AppImage (needs `fuse2`), the `.deb`/`.rpm`, or on Arch build
`packaging/arch/PKGBUILD` (`makepkg -si`), which uses the system WebKitGTK and
updates through pacman.

- **Vault**: needs a running Secret Service (`gnome-keyring`, or KeePassXC with
  Secret Service on). The app checks at startup and shows the fix if it is missing.
- **Tray**: StatusNotifierItem — KDE, XFCE, waybar's `tray` module; GNOME needs
  the AppIndicator extension. Left-click toggles the window.
- **Proxy for other apps**: there is no system-wide proxy setting to write, so
  the router panel hands out ready-to-paste lines instead — `env` lines for
  `hyprland.conf` (or `export` for a shell profile), a Chromium flag, and
  Firefox steps, all filled in with the router port.
- **Hyprland**: ignores XDG autostart; Settings shows the `exec-once` line when
  start-at-login is on. On the NVIDIA driver the app disables WebKit's DMA-BUF
  renderer itself, which otherwise draws a blank window.
- Process capture and the automatic system-proxy toggle are Windows-only.

## Proxy router

One SOCKS5 port on `127.0.0.1`; rules evaluated top to bottom, first enabled
match wins.

| Kind | Example | Matches |
| --- | --- | --- |
| Host wildcard | `*.corp.example.com` | domain and subdomains |
| Host regex | `\.internal$` | unanchored, case-insensitive |
| IP CIDR | `10.0.0.0/8` | literal IPs, and hostnames when local resolution is on |
| Everything | — | catch-all |

Each rule may require a destination port and resolves to **tunnel**, **direct**
(bypass tunnels), or **block**. Unmatched traffic takes the default action. A
rule targeting a down tunnel **connects it on demand** and holds the request
until the session authenticates.

Point apps at it manually (`curl --socks5-hostname 127.0.0.1:1090 …`) or tick
*"Point the Windows system proxy here"* — the app serves a PAC script and sets
only WinINET's `AutoConfigURL`, restoring it on stop (backup replayed on next
startup after a crash). PAC is required because Windows' plain `ProxyServer`
setting means SOCKS4, which the listener refuses. The script forwards everything
(minus the bypass list) with no `DIRECT` fallback, so a stopped router fails
closed.

Panel also has a rule **test box** and a **decision log** of recent connections.
The router only binds `127.0.0.1`.

### DNS

Hostnames are **not** resolved locally before SSH — the name goes down the
tunnel and the server resolves it (`ssh -D` behavior), so internal names work
and DNS doesn't leak. Use `--socks5-hostname`, not `--socks5`. IP/CIDR rules
need an address: the *"Resolve hostnames locally so IP/CIDR rules can match"*
setting (default on) does one lookup per connection for matching only.

## Process capture

For apps that ignore proxy settings. Capture launches the target with a hook DLL
injected before its first instruction, redirecting
`connect`/`WSAConnect`/`ConnectEx`/`getaddrinfo` to the router's SOCKS5 port
with hostnames preserved. Fails closed — if the hook isn't installed before the
main thread runs, the process is killed rather than resumed unhooked. Captures
survive an unclean shutdown and are re-adopted on restart (PID-reuse guarded by
an exe-path check).

## SSH terminal

**Terminal** in the header opens a separate window. Every tunnel is a host
there (add one with SOCKS off if you only want a shell). A terminal opens a PTY
channel on the tunnel's existing session — connecting it, and its jump chain,
if needed — so it shares credentials, host-key checks and the connection
itself. If the session drops, press Enter to reconnect.

- **Tabs and split panes** — drag a host from the sidebar tree, a tab, or a
  pane header onto any edge of a pane to split it (a preview shows where it
  lands); drop on the tab bar for a new tab. Moving a pane never restarts its
  shell. Drag dividers to resize, double-click to even them out.
- **Broadcast** — type into every pane of a tab at once, with per-pane opt-out.
  Multi-line pastes to several servers ask first.
- xterm.js with WebGL rendering; mouse apps (htop, mc, vim) work.
- Echo latency and throughput in the footer.

| Keys | Action |
| --- | --- |
| Ctrl+C | always SIGINT |
| select text / Ctrl+Shift+C | copy |
| Ctrl+Shift+V / right-click | paste |
| Ctrl+Shift+D / Ctrl+Shift+E | split right / down with the same host |
| Alt+arrows | move focus between panes |
| Ctrl+Shift+Z | zoom pane |
| Ctrl+Shift+B | toggle broadcast |
| Ctrl+Shift+W | close pane |
| Ctrl+Shift+K | find host |
| Ctrl+Tab, Ctrl+1…9 | switch tab |

Shortcuts stay off plain Ctrl+letter, which belongs to the shell.

## Export / import

Settings → *Export / import config* writes one JSON file: tunnels, forwards,
router config and rules, settings (including theme), known hosts. Terminal
hosts are tunnels, so they come along; tunnels are written in display order and
new ones are imported in that order.

Secrets are separate. Blank passphrase → passwords/key passphrases are **not
written** (stay in Credential Manager, file safe to share). With a passphrase
they go in a sealed block: Argon2id derives the key, AES-256-GCM seals it, fresh
salt+nonce per export. No recovery if forgotten.

Import previews, is section-scoped, and:

- Tunnels match by **id** (update in place) or **name** (conflict — replace or
  import alongside as `… (imported)`).
- Router rules **replace** the list, not merge; tunnel targets rewritten to
  follow any re-id'd tunnel.
- Known hosts merge, **yours win** (TOFU).

## Development

Needs [Bun](https://bun.sh) and the
[Rust MSVC toolchain](https://www.rust-lang.org/tools/install).

```sh
bun install
bun run tauri dev

# checks (no linter; tests cover the router rule matcher + PAC)
./node_modules/.bin/tsc --noEmit -p tsconfig.json
cd src-tauri && cargo check && cargo test

bun run tauri build   # installers under src-tauri/target/release/bundle/
```

## Releasing

```sh
bun run bump <x.y.z>   # rewrites version in package.json, tauri.conf.json, Cargo.toml, Cargo.lock
git commit -am "Bump version to <x.y.z>"
git tag v<x.y.z>
git push origin master v<x.y.z>
```

A `v*.*.*` tag triggers the `Release` workflow: signed installers, a draft
GitHub release, and the `latest.json` the in-app updater polls. Requires the
`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repo secrets
(`bunx tauri signer generate`).

## Architecture

React frontend is a thin view; the Rust backend owns all tunnel and routing
state.

```
src/                React UI — panels, event hooks, typed IPC wrappers
  terminal/          terminal window: panes, tabs, drag-and-drop, broadcast
  themes/            theme catalogue and token derivation
src-tauri/src/
  commands.rs        every #[tauri::command]; the IPC surface
  tunnel.rs          AppState: running tunnels, statuses, router state
  ssh/               per-tunnel supervisor, SOCKS5 + local forwards, TOFU,
                     terminal PTY channels
  router/            rule matcher, listener, Windows system proxy, PAC
  capture/           process launch + hook-DLL injection
  db.rs              SQLite: tunnels, forwards, router rules
  secrets.rs         Windows Credential Manager
  settings.rs        JSON-backed settings and router config
```

Each tunnel is a supervisor task that binds its listeners **once** and keeps an
authenticated SSH session behind them, reconnecting with backoff — a reconnect
never surrenders the local ports. The router reuses those sessions. State splits
three ways: SQLite (tunnels/forwards/rules), OS credential vault (secrets), JSON
files (settings, router config).

## Stack

Tauri v2 · React 19 · TypeScript · Tailwind CSS v4 · xterm.js · `russh` · `fast-socks5` ·
`rusqlite` · `regex` + `ipnet` · `minhook`

## License

[GPL-3.0](LICENSE).
