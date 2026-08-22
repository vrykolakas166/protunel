# ProdTunnel

Desktop SSH tunnel manager for Windows. Add a host, flip a switch, get a local
`socks5://127.0.0.1:<port>` proxy tunneled through SSH — no PuTTY/plink required.

Rebuilt on [Tauri](https://tauri.app) + React/TypeScript from an older
WinForms/.NET app, with an embedded Rust SSH client instead of shelling out to
`plink.exe`.

## Features

- Password, private-key, or SSH-agent (Pageant) authentication
- Per-tunnel SOCKS5 proxy and static local port forwards (`-D` and `-L`)
- **Rule-based proxy router** — one local port that picks a tunnel per
  destination, no browser extension required (see below)
- Jump tunnels: a tunnel can connect through another tunnel's live session, and
  connecting the inner one dials the whole chain
- Auto-reconnect with backoff, keepalive-based dead-peer detection, and local
  ports held across an outage so nothing else can steal them
- Real TOFU host-key verification — unknown keys prompt for explicit
  confirmation with the fingerprint shown; known hosts are checked on every
  connect and mismatches are rejected (not silently trusted)
- Known-hosts manager to review/revoke trusted keys
- Live per-tunnel transfer stats (bytes up/down, uptime)
- Connect all / disconnect all, tunnel search, clone tunnel
- System tray with per-tunnel toggles, hide-to-tray on close, single-instance
- Native OS notifications on connect/disconnect/error
- Config export/import for moving to another machine, with secrets encrypted
  under a passphrase (or left out entirely)
- Guided in-app tour, replayable from Settings
- Auto-updater with signed releases
- System/Light/Dark theme

Secrets (passwords, key passphrases) are stored in the Windows Credential
Manager via `keyring`, never in the local SQLite database.

## The proxy router

Per-tunnel SOCKS ports make you choose a tunnel per *application*. The router
inverts that: one SOCKS5 port on `127.0.0.1`, and an ordered rule list decides
per *destination* where each connection goes.

Rules are evaluated top to bottom and the first enabled match wins:

| Kind | Pattern example | Matches |
| --- | --- | --- |
| Host wildcard | `*.corp.example.com` | that domain and any subdomain |
| Host regex | `\.internal$` | unanchored, case-insensitive |
| IP CIDR | `10.0.0.0/8` | literal-IP destinations, and hostnames when local resolution is on |
| Everything | — | explicit catch-all |

Each rule can also require a specific destination port, and resolves to one of
three actions: send it through a **tunnel**, go **direct** (bypass every
tunnel), or **block** it. Anything unmatched takes the configured default
action.

A rule pointing at a tunnel that isn't up **connects it on demand** and holds
the request until the SSH session authenticates, so you can enable the router
and let tunnels dial themselves as traffic arrives.

Point things at it either way:

- **Manually** — `curl --socks5-hostname 127.0.0.1:1090 https://…`, or set the
  proxy in an app's own settings.
- **System-wide** — tick *"Point the Windows system proxy here while running"*.
  The app serves a tiny PAC script on a loopback port and points WinINET's
  `AutoConfigURL` at it, then restores the previous value when the router stops
  — including after a crash: a backup file written before the first registry
  write is replayed on next startup.

  It has to be a PAC script rather than the plain proxy setting because
  Windows' `ProxyServer = socks=host:port` means **SOCKS4**, which a SOCKS5
  listener must refuse. A PAC script can name `SOCKS5` explicitly. The script
  does not duplicate the rule list — it sends everything to the router (minus
  the bypass list) and lets the matcher decide, and it has no `DIRECT`
  fallback, so a stopped router fails closed instead of quietly letting traffic
  escape the rules.

  Only `AutoConfigURL` is written; any fixed proxy you already had configured is
  left alone.

The panel also has a **test box** (type a hostname, see which rule wins without
sending traffic) and a **decision log** of recent connections, which is how you
answer "why did that request go direct?".

The router only ever binds `127.0.0.1`. An externally reachable SOCKS proxy with
a route into your bastions would be an open relay.

### DNS behavior

Hostnames are **not** resolved locally before being handed to SSH — the name
travels down the tunnel and the SSH server resolves it, matching `ssh -D`. That
means internal-only names work and DNS doesn't leak to your local resolver. Use
`--socks5-hostname` (not `--socks5`) with curl so the hostname actually reaches
the router; `--socks5` resolves client-side and the rules will only ever see an
IP.

IP/CIDR rules still need an address to compare against. The
*"Resolve hostnames locally so IP/CIDR rules can match them"* setting (on by
default) does one local lookup per connection for that purpose only. Turn it off
and CIDR rules simply never match hostname destinations.

## Export and import

Settings → *Export / import config* writes the whole configuration to one JSON
file: tunnels and their port forwards, router config and rules, settings, and
known hosts.

Secrets are handled separately. Leave the passphrase blank and SSH passwords and
key passphrases are simply **not written** — they stay in the Windows Credential
Manager, and the file is safe to commit or send. Set a passphrase and they are
included in their own sealed block:

```json
"secrets": { "kdf": "argon2id", "salt": "…", "nonce": "…", "ciphertext": "…" }
```

Argon2id derives the key; AES-256-GCM seals it. Salt and nonce are regenerated on
every export, so exporting the same config twice never produces the same
ciphertext. There is no recovery path if you forget the passphrase.

Import previews before it commits, and is section-scoped — you choose whether to
take tunnels, router config, settings, known hosts, and secrets. Notes:

- Tunnels matching an existing **id** update in place. Matching only by **name**
  is flagged as a conflict; you decide whether to replace yours or bring the
  imported one in alongside as `… (imported)`.
- Router rules **replace** the existing list rather than merging — position is
  what a rule list means, so interleaving two of them produces an order nobody
  chose. Rule tunnel targets are rewritten to follow any tunnel that got a new
  id, so an imported rule never points at the wrong tunnel.
- Known hosts are merged and **yours always win**. Silently replacing a trusted
  host key from a file would defeat the point of TOFU.

## Development

Requires [Bun](https://bun.sh) and the
[Rust toolchain](https://www.rust-lang.org/tools/install) with the MSVC build
tools.

```sh
bun install
bun run tauri dev
```

Checks (there is no linter; tests cover the router's rule matcher and PAC script):

```sh
./node_modules/.bin/tsc --noEmit -p tsconfig.json
cd src-tauri && cargo check && cargo test
```

## Building

```sh
bun run tauri build
```

Produces installers under `src-tauri/target/release/bundle/`.

## Releasing

Bump the version across `package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock` in one shot:

```sh
bun run bump 0.2.1
```

Then commit, tag, and push:

```sh
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "Bump version to 0.2.1"
git tag v0.2.1
git push origin master v0.2.1
```

Push a tag matching `v*.*.*` (e.g. `v0.2.0`) — the `Release` GitHub Actions
workflow builds signed installers and publishes them as a GitHub release,
along with the `latest.json` manifest the in-app updater checks against.

Requires the `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets (generate a keypair
with `bunx tauri signer generate`).

## Architecture

The React frontend is a thin view; the Rust backend owns all tunnel and routing
state.

```
src/                    React UI — panels, event hooks, typed IPC wrappers
src-tauri/src/
  commands.rs           every #[tauri::command]; the whole IPC surface
  tunnel.rs             AppState: running tunnels, statuses, router state
  ssh/                  per-tunnel supervisor, SOCKS5 + local forwards, TOFU
  router/               rule matcher, router listener, Windows system proxy
  db.rs                 SQLite: tunnels, port forwards, router rules
  secrets.rs            Windows Credential Manager
  settings.rs           JSON-backed settings and router config
```

Each tunnel is a supervisor task that binds its local listeners **once** and
keeps an authenticated SSH session behind them, reconnecting with backoff when
the session dies — so a reconnect never surrenders the local ports. The router
is a separate listener that reuses those same sessions.

State lives in three places: SQLite for tunnels/forwards/rules, the OS
credential vault for secrets, and JSON files for settings and router config
(all under the app data directory).

## Stack

Tauri v2 · React 19 · TypeScript · Tailwind CSS v4 · `russh` (SSH client) ·
`fast-socks5` · `rusqlite` · `regex` + `ipnet` (rule matching)
