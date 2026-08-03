# ProdTunnel

Desktop SSH SOCKS-tunnel manager for Windows. Add a host, flip a switch, get a
local `socks5://127.0.0.1:<port>` proxy tunneled through SSH — no PuTTY/plink
required.

Rebuilt on [Tauri](https://tauri.app) + React/TypeScript from an older
WinForms/.NET app, with an embedded Rust SSH client instead of shelling out to
`plink.exe`.

## Features

- Password, private-key, or SSH-agent (Pageant) authentication
- Real TOFU host-key verification — unknown keys prompt for explicit
  confirmation with the fingerprint shown; known hosts are checked on every
  connect and mismatches are rejected (not silently trusted)
- Known-hosts manager to review/revoke trusted keys
- Live per-tunnel transfer stats (bytes up/down, uptime)
- Connect all / disconnect all, tunnel search, clone tunnel
- System tray with per-tunnel toggles, hide-to-tray on close, single-instance
- Native OS notifications on connect/disconnect/error
- Auto-updater with signed releases
- System/Light/Dark theme

Secrets (passwords, key passphrases) are stored in the Windows Credential
Manager via `keyring`, never in the local SQLite database.

## Development

Requires [Bun](https://bun.sh) and the
[Rust toolchain](https://www.rust-lang.org/tools/install) with the MSVC build
tools.

```sh
bun install
bun run tauri dev
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

## Stack

Tauri v2 · React 19 · TypeScript · Tailwind CSS v4 · `russh` (SSH client) ·
`fast-socks5` · `rusqlite`
