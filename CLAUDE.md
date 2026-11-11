# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **Bun**. Rust side needs the MSVC toolchain (Windows-only app).

```sh
bun install
bun run tauri dev        # Vite on :5420 + Rust app, both hot-reloaded
bun run tauri build      # installers under src-tauri/target/release/bundle/
bun run bump 0.3.3       # rewrites version in package.json, tauri.conf.json, Cargo.toml, Cargo.lock
```

Verification (no linter; the only tests cover the router's rule matcher):

```sh
./node_modules/.bin/tsc --noEmit -p tsconfig.json    # frontend typecheck
cd src-tauri && cargo check                          # backend typecheck (much faster than a full build)
cd src-tauri && cargo test --lib router              # rule matcher + PAC tests
```

Do not run `cargo clean -p protunel` — it evicts the whole dependency graph
(~6 GiB) and costs a multi-minute rebuild, not just the local crate.

Release: `bun run bump <x.y.z>`, commit, `git tag vX.Y.Z`, push tag. The `Release`
workflow (`.github/workflows/release.yml`) builds signed installers and publishes a
**draft** GitHub release plus the `latest.json` the in-app updater polls.

## Architecture

Tauri v2 desktop app. React/TS frontend is a thin view over a Rust backend that owns
all tunnel state; the frontend holds no source of truth beyond what it was told.

### Adding or changing an IPC command

A command touches four places and all four must agree:

1. `src-tauri/src/commands.rs` — `#[tauri::command]` fn, returns `Result<T, String>`
2. `src-tauri/src/lib.rs` — register in `invoke_handler![...]`
3. `src/api.ts` — typed `invoke<T>()` wrapper
4. `src/types.ts` — mirror of the Rust type

Rust structs crossing the boundary use `#[serde(rename_all = "camelCase")]`, so
`local_socks_port` in Rust is `localSocksPort` in TS. Tauri also camel-cases argument
names (`key_id` param → `{ keyId }` in the JS call).

### Tunnel lifecycle (`src-tauri/src/ssh/mod.rs`)

`run_tunnel` is a per-tunnel supervisor task owning one tunnel for its whole life:

- **Listeners are bound once, in `bind_listeners`, not per SSH session.** Rebinding on
  reconnect would surrender the local ports during an outage. `run_session` serves
  traffic over one authenticated session; when it dies the loop reconnects behind the
  same listeners.
- Liveness comes from russh keepalives killing the session; `HEALTH_CHECK_INTERVAL`
  polling of `session.is_closed()` is only how fast the supervisor notices.
- Retry policy: `is_fatal` (a fixed substring list of unrecoverable error texts) →
  `should_retry` → `backoff` (2/4/8/16s then flat 30s). A session that lived ≥60s
  resets the attempt counter to 1, so a flapping server still escalates.
- Live forward add/remove flows over an `mpsc` `ForwardCommand` channel, handled both
  in `run_session` *and* in `wait_before_retry` — editing forwards must not block on a
  backoff sleep.

`AppState` (`tunnel.rs`) holds the `running` map of `TunnelHandle`s (cancel token, byte
counters, forward sender, session slot) plus a `statuses` map. Status events are
fire-and-forget, so `statuses` is what `list_tunnel_statuses` replays to seed a
reloaded webview (`useTunnelEvents` merges the snapshot without clobbering live events).

**Jump tunnels**: a tunnel with `jump_tunnel_id` connects via a `direct-tcpip` channel
on the parent's live session. `connect_one` walks the chain, connects outermost first,
and `wait_for_session` polls until each hop is *authenticated* (not merely spawned)
before starting the next.

### Proxy router (`src-tauri/src/router/`)

A second, tunnel-independent SOCKS5 listener that picks a destination per
connection instead of per application.

- `rules.rs` — the matcher. Rules are
  ordered, first enabled match wins. `Target` deliberately does not depend on
  `fast_socks5` so the matcher stays testable.
- `mod.rs` — `RouterState`: config store, **compiled** rule snapshot, decision log,
  cancel token. The compiled snapshot is `RwLock<Arc<Vec<CompiledRule>>>` and callers
  clone the `Arc` out before awaiting — never hold that lock across an await, and
  never recompile a regex on the connection path.
- `listener.rs` — accept loop and dispatch. On-demand tunnel dials go through
  `RouterState::connect_lock`; without it, one page load races several
  `connect_one` calls past the `is_connected` check and orphans tunnel tasks.
- `pac.rs` — loopback HTTP endpoint serving the PAC script. Required, not a
  convenience: WinINET's `ProxyServer = socks=host:port` means **SOCKS4**, which
  the SOCKS5 listener refuses, so the fixed-proxy setting cannot reach the router.
  The script must never grow a copy of the rule list — it forwards everything
  (minus the bypass list) and lets `rules.rs` decide — and must keep its
  no-`DIRECT`-fallback ending so a dead router fails closed.
- `system_proxy.rs` — writes **only** `AutoConfigURL`; the fixed-proxy keys are
  captured in the backup but never set, so a user's existing proxy config
  survives. `system_proxy_backup.json` is written *before* the first registry
  write and deleted only after a successful restore, which makes it the
  crash-recovery record. `disable()` is a no-op without it, so startup recovery
  is just a `disable()` call. Cleanup hangs off `RunEvent::Exit` in `lib.rs` —
  that is the only clean-shutdown hook, since tray Exit calls `app.exit(0)`.

Any rule or config mutation must end in `router::apply_change` (or `start`) so the
compiled snapshot and the live listener stay in step with the database.

**DNS**: neither `ssh/socks.rs` nor the router calls `resolve_dns()`. Hostnames go
to the SSH server unresolved, which is what makes rule matching and internal-only
names work. Re-adding a local resolve would break both.

### Terminal (`src-tauri/src/ssh/terminal.rs`, `src/terminal/`)

Interactive shells in a second window (label `terminal`, page `terminal.html`,
its own Vite entry and `capabilities/terminal.json`). Hosts *are* tunnels — a
terminal-only host is a tunnel with `socks_enabled = false` — so they share the
vault, TOFU, jump chain and config export/import with no extra storage.

- A terminal never owns a connection: `terminal::open` runs `connect_one` +
  `wait_for_session`, then opens a PTY `session` channel on the tunnel's live
  handle. It dies with that session; the frontend offers Enter-to-reconnect.
- Output goes over a per-terminal `ipc::Channel` as `InvokeResponseBody::Raw`
  (an `ArrayBuffer` in JS — never JSON number arrays). The pump drains already
  queued channel messages before sending, so bursts coalesce (≤64 KiB) while a
  lone keystroke echo is never delayed by a timer.
- Split panes: each tab is a binary tree (`src/terminal/layout.ts`, pure
  functions) but `PaneLayer` renders the panes of **every tab** in one flat
  layer, absolutely positioned and keyed by pane id. Never render per tab or
  recurse the tree — a pane changing depth or tab would remount its
  `TerminalView` and kill the shell. Drag-and-drop (`tabs.ts` `canDrop` /
  `applyDrop`, `useDragDrop`) relies on this to move live sessions between
  tabs; every move must keep pane ids.
- Broadcast fans out in Rust (`terminal_write_many`) so every shell gets the
  same bytes in the same order; the frontend only picks the target ids.
- Only the `main` window hides on close; destroying the terminal window calls
  `Terminals::close_all`.
- Window shortcuts live in `src/terminal/shortcuts.ts` and xterm is told to
  ignore exactly those keys. Keep them off plain Ctrl+letter: the shell owns
  those (Ctrl+K kill-line, Ctrl+B tmux prefix).
- Both windows show tunnels and host-key prompts, so `tunnels-changed` (emit
  via `commands::tunnels_changed`) and `host-key-resolved` keep them in step.

### Config export/import (`src-tauri/src/config_io.rs`)

One JSON bundle. The file dialog is driven from **Rust** (`tauri-plugin-dialog`),
not TS — that keeps file contents off the IPC boundary and out of
`capabilities/default.json`.

- Secrets are sealed separately: Argon2id → AES-256-GCM, fresh salt and nonce per
  export. `open()` reports a failed AEAD tag as *wrong passphrase*, because that
  is what it almost always is. Never widen the export to include secrets
  unsealed — the whole point is that the vault is the only plaintext store.
- `apply_import` decrypts **before** writing anything, so a bad passphrase can't
  leave tunnels imported without credentials.
- Tunnel ids can change on import (name conflicts imported as copies), so every
  id goes through `id_map` and router rule targets are rewritten through it.
  Forwards always get fresh ids or a copy collides with the original's primary key.
- `KnownHosts::merge` keeps the existing key on conflict — do not "fix" this into
  an overwrite, it is the TOFU guarantee.

### Persistence, split three ways

- **SQLite** (`db.rs`, `protunel.db` in `app_data_dir`) — tunnels, port forwards, and
  router rules.
  Migrations are additive `ALTER TABLE` calls in `migrate()` whose errors are ignored;
  a new column means touching `SCHEMA`, `migrate`, the `COLUMNS` const, `row_to_tunnel`,
  `insert`, and `update` together. The exception is `tunnels.position` (display
  order): it lives only in SQL — `insert` appends, `update` never touches it,
  `reorder_tunnels` rewrites it — so editing a tunnel can't move it.
- **OS credential vault** (`secrets.rs`, `keyring`) — passwords and key passphrases,
  keyed by tunnel UUID. Never in SQLite.
- **JSON files** in `app_data_dir` — `settings.json`, `router.json` (both
  `settings.rs`, via the shared `JsonStore<T>`), and `known_hosts.json`
  (`ssh/known_hosts.rs`). New `Settings` fields need `#[serde(default …)]` or
  existing installs fail to deserialize and silently reset. Router config is a
  *separate* store on purpose: the settings panel writes back a whole `Settings`
  object and would otherwise clobber router state edited in the other panel.

### Host-key TOFU

`SshHandler::check_server_key` consults `KnownHosts`; an unknown key emits
`host-key-pending` and *blocks the connection* on a `oneshot` resolved by the
`confirm_host_key`/`reject_host_key` commands (120s timeout, default deny). A stored
key that mismatches is rejected outright. Do not weaken this into auto-trust — it is
the main thing this rewrite fixed versus the old WinForms/plink app.

### Events

Names are declared in `events.rs` and consumed by the hooks in `src/hooks/`:
`tunnel-status`, `tunnel-stats` (1 Hz per connected tunnel), and `host-key-pending`
in `useTunnelEvents.ts`; `router-status` and `router-stats` (1 Hz while running) in
`useRouterEvents.ts`. The routing decision log is *polled* by `RouterPanel`, not
evented — it grows once per proxied connection, which is far too chatty for an event.

### Tray and window

Closing the window hides it (`on_window_event` → `prevent_close` + `hide`); exit is
tray-only. `tray::rebuild_menu` rebuilds the whole menu and is called on every status
transition and every tunnel add/edit/delete — tray checkmarks have no other update path.

### Frontend conventions

- Tailwind v4, configured CSS-first in `src/index.css` via `@theme`. Semantic color
  tokens only (`bg-surface`, `text-muted`, `bg-accent`, `bg-coral`) — dark mode swaps
  the variables under `.dark`, which `useTheme` toggles. Raw palette classes break dark
  mode.
- Fonts are self-hosted woff2 in `src/assets/fonts` (no CDN; the webview is offline).
- `src/App.tsx` owns tunnel list, settings, and dialog state; child components are
  presentational and call back up.
- `TourGuide` spotlights whatever carries the matching `data-tour="…"` attribute, so
  moving or renaming one silently drops a step back to a centred card. Steps that
  live inside a modal declare a `panel`, and `App.showTourPanel` opens exactly that
  one — which is why measurement retries on `requestAnimationFrame`: the target does
  not exist until the panel it lives in has mounted.

### Capabilities

`src-tauri/capabilities/default.json` gates what the *frontend* may call. Plugins used
only from Rust (notification, autostart) need no entry; anything invoked from TS does.
