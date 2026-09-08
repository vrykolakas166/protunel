# protunel

Desktop SSH tunnel manager for Windows. Add a host, flip a switch, get a local
`socks5://127.0.0.1:<port>` proxy tunneled through SSH — no PuTTY/plink.
[Tauri](https://tauri.app) + React/TypeScript, embedded Rust SSH client.

## Features

- Password, private-key, or SSH-agent (Pageant) auth
- Per-tunnel SOCKS5 proxy and static local forwards (`-D`, `-L`)
- **Proxy router** — one local SOCKS5 port, ordered rules pick a tunnel per
  *destination* instead of per app
- **Process capture** — launch any `.exe` with a hook DLL that forces its
  outbound TCP through the router, no system proxy change
- **Jump tunnels** — a tunnel connects through another tunnel's live session;
  connecting the inner one dials the whole chain
- Auto-reconnect with backoff, keepalive dead-peer detection, local ports held
  across outages
- TOFU host-key verification — unknown keys prompt with fingerprint; mismatches
  rejected, not silently trusted. Known-hosts manager to review/revoke
- Live per-tunnel stats, connect/disconnect all, search, clone
- System tray toggles, hide-to-tray, single-instance, OS notifications
- Encrypted config export/import
- Guided tour, signed auto-updater, System/Light/Dark theme

Secrets (passwords, key passphrases) live in Windows Credential Manager via
`keyring`, never in SQLite.

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

## Export / import

Settings → *Export / import config* writes one JSON file: tunnels, forwards,
router config and rules, settings, known hosts.

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
src-tauri/src/
  commands.rs        every #[tauri::command]; the IPC surface
  tunnel.rs          AppState: running tunnels, statuses, router state
  ssh/               per-tunnel supervisor, SOCKS5 + local forwards, TOFU
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

Tauri v2 · React 19 · TypeScript · Tailwind CSS v4 · `russh` · `fast-socks5` ·
`rusqlite` · `regex` + `ipnet` · `minhook`

## License

[MIT](LICENSE).
