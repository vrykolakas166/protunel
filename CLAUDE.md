# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **Bun**. Targets Windows (MSVC toolchain) and Linux x86_64
(WebKitGTK 4.1 + ayatana-appindicator dev packages; see `release.yml`).
Windows-only features — process capture (`capture/`) and the system proxy
(`router/system_proxy.rs`) — keep platform-neutral signatures with non-Windows
stubs (`capture/unsupported.rs`), and the UI hides them via `src/platform.ts`.
The hook DLL resource is declared only in `tauri.windows.conf.json`.
On Linux, `platform.rs` (`platform_status`) reports desktop, Secret Service and
agent reachability, distro install command, and whether self-update applies
(AppImage only); the frontend reads it once via `getPlatformStatus()` and drives
`SetupNotice`, `LinuxProxyHelp` and the Hyprland autostart hint from it. Arch
packaging lives in `packaging/arch/PKGBUILD` (repackages the release `.deb`;
`bun run bump` keeps its pkgver in step). `.github/workflows/pacman-repo.yml` publishes it
to the `pacman-repo` prerelease (never "latest": the updater reads releases/latest).

```sh
bun install
bun run tauri dev        # Vite on :5420 + Rust app, both hot-reloaded
bun run tauri build      # installers under src-tauri/target/release/bundle/
bun run bump 0.3.3       # rewrites version in package.json, tauri.conf.json, Cargo.toml, Cargo.lock
```

Verification (no linter; tests cover the router's rule matcher and a few pure
frontend helpers in `tests/`):

```sh
./node_modules/.bin/tsc --noEmit -p tsconfig.json    # frontend typecheck
cd src-tauri && cargo check                          # backend typecheck (much faster than a full build)
cd src-tauri && cargo test --lib router              # rule matcher + PAC tests
bun test tests                                       # host ranges, terminal key handling
```

Do not run `cargo clean -p protunel` — it evicts the whole dependency graph
(~6 GiB) and costs a multi-minute rebuild, not just the local crate.

Release: see "Packaging & releases" below.

## Packaging & releases

Release assets (per tag `vX.Y.Z`): `protunel_<v>_amd64.AppImage` (+ `.sig`),
`protunel_<v>_amd64.deb`, `protunel-<v>-1.x86_64.rpm`, `protunel_<v>_x64-setup.exe`,
`protunel_<v>_x64_en-US.msi`, `latest.json`. The in-app updater works only for
Windows and AppImage (`platform.rs` `self_update`); `.deb`/`.rpm` are not updated.

**Flow**

```sh
bun run bump <x.y.z>   # package.json, tauri.conf.json, Cargo.toml, Cargo.lock, packaging/arch/PKGBUILD
git commit -am "Bump version to <x.y.z>"
git tag v<x.y.z>
git push origin master v<x.y.z>
```

**In-app updates** live in Rust (`updates.rs`), not the JS updater plugin, so they
work while the window is hidden for days: a check 20 s after launch then every
6 h, background download when `settings.auto_update`, a "Restart to update" item
in the tray (`tray::build_menu`) and a banner. `install_and_restart` writes
`resume.json` (running tunnel ids, reconnected by `updates::connect_on_launch`,
which also handles per-tunnel "connect on startup") and `whats_new.json` (shown
once by the new version via `take_whats_new`). AppImage builds also install a
ready update in `RunEvent::Exit`; Windows does not, because its installer
relaunches the app. The Windows installer ends the process with
`std::process::exit`, so `on_before_exit` repeats the exit cleanup (system proxy).

A `v*.*.*` tag triggers the `Release` workflow: signed installers, a **draft**
GitHub release, and the `latest.json` the in-app updater polls. Needs repo secrets
`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
(`bunx tauri signer generate`). Publishing the draft (it holds all assets by then)
triggers the `Pacman repo` workflow, which adds the `.deb` to the `pacman-repo`
release. It can also be run by hand for any tag (Actions, "Pacman repo", Run workflow);
the first dispatch is manual since publishes made with `GITHUB_TOKEN` never start workflows.

**Arch (self-hosted signed pacman repo)**

- `packaging/arch/PKGBUILD` (`protunel-bin`) repackages the release `.deb`, so the
  app links the system `webkit2gtk-4.1` instead of the AppImage's bundled copy.
  The app detects the package install and hides its updater ("Updates come from
  your package manager"). `bump` rewrites pkgver, resets pkgrel and clears the
  sha256; `updpkgsums` refills it (the workflow does this itself).
- Build by hand: `cd packaging/arch && makepkg -si`.
- `.github/workflows/pacman-repo.yml` builds with `makepkg --nodeps`: `package()`
  only unpacks the `.deb`, so runtime deps (webkit2gtk-4.1, gtk3...) are not needed
  to build; pacman resolves them on the user's machine.
- The `pacman-repo` release must stay a **prerelease and never "latest"** — the
  updater reads `releases/latest`. The workflow fails if it becomes latest.
- Signing: secrets `PACMAN_GPG_KEY` (armored private key) and `PACMAN_GPG_KEY_ID`
  sign the package and database (optional; without them the repo is unsigned).
  Repo key fingerprint `017C5997B8FE5A79784BA2C29A38E414ECE95901`, public key in
  `packaging/arch/protunel-repo.asc`. The private key lives on the owner's machine in a
  dedicated GNUPGHOME (`~/.local/share/protunel-repo-gnupg`); never commit it.
- Client setup is `packaging/arch/install.sh` (`curl ... | sudo bash`, `-s -- --uninstall`
  to remove): verifies the key fingerprint against the hard-coded one before
  `pacman-key --add`/`--lsign-key`, writes `/etc/pacman.d/protunel.conf`
  (`SigLevel = Required`, `Server = .../releases/download/pacman-repo`), appends an
  `Include` to `/etc/pacman.conf`, installs `protunel-bin`. Rotating the key means
  updating the FPR in `install.sh`, the README manual steps and the key file.
  `PACMAN_CONF`/`PACMAN_D`/`KEY_FILE`/`PROTUNEL_TEST=1` let it be tested on copies.
  `--disable` / `--enable` comment / uncomment the `Include` line (idempotent, no
  network or gpg) so a broken repo can't block `pacman -Syu`; `--uninstall` removes
  either form of the line plus the blank line the installer added before it.
- Workflow upload order is deliberate so the repo is never left broken: upload the new
  package (+ .sig), then the db/files (+ .sig) with `--clobber`, and only then delete
  older package assets. The last step, "verify published repo", downloads the live
  db/package from the release, checks signatures with `gpg`, checks the key
  fingerprint matches the `FPR` in `install.sh` (parsed by grep), and runs real
  `pacman -Sy`/`-Si protunel-bin` against it (temp config/dbpath/gpgdir,
  `--disable-sandbox`), failing unless the version equals the one just built.
  Packages carry `PACKAGER="protunel CI <...>"`.

## Architecture

Tauri v2 desktop app. React/TS frontend is a thin view over a Rust backend that owns
all tunnel state; the frontend holds no source of truth beyond what it was told.

### Adding or changing an IPC command

A command touches four places and all four must agree:

1. `src-tauri/src/commands/<subject>.rs` (tunnels, connection, host_keys,
   terminal_window, router_rules, app_settings, app_update, process_capture,
   dev_tools; re-exported by `commands/mod.rs`, so it is still
   `commands::name`) — `#[tauri::command]` fn; one that can fail returns
   `Result<T, String>` (plain getters return `T`)
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
- Editing a running tunnel: `update_tunnel` restarts it on the spot when
  `needs_reconnect` says the change touches the connection (host, port, user,
  auth, secret, jump, SOCKS listener) — `stop_and_wait` lets the old task free
  its ports first. Renames don't restart. Each reconnect attempt inside
  `run_tunnel` re-reads the tunnel and secret from DB/vault, so a retry never
  uses stale credentials. `TunnelHandle::generation` keeps an old task that ends
  late from `clear`ing its successor. Terminal panes show the `target` their
  shell was opened with and flag it when the saved host differs.

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
- `listener.rs` — accept loop and dispatch. `dispatch` peeks the first byte:
  `G` goes to `serve_pac` (only an exact `GET /protunel.pac` is answered, so an
  app that mistook the port for an HTTP proxy is still refused), anything else
  is SOCKS5 as before. On-demand tunnel dials go through
  `RouterState::connect_lock`; without it, one page load races several
  `connect_one` calls past the `is_connected` check and orphans tunnel tasks.
- `pac.rs` — loopback HTTP endpoint serving the PAC script. Required, not a
  convenience: WinINET's `ProxyServer = socks=host:port` means **SOCKS4**, which
  the SOCKS5 listener refuses, so the fixed-proxy setting cannot reach the router.
  The script must never grow a copy of the rule list — it forwards everything
  (minus the bypass list) and lets `rules.rs` decide — and must keep its
  no-`DIRECT`-fallback ending so a dead router fails closed. That applies to
  the Windows system-proxy copy (`build_script(.., false)`), which protunel
  removes on exit. A second copy is served on the router port itself
  (`/protunel.pac`) for hand-configured browsers and **does** end
  `; DIRECT` (`build_script(.., true)`): protunel cannot unconfigure a browser
  on exit, and a browser that fails to re-fetch its PAC keeps running the last
  one it loaded (Firefox does), so without the fallback closing protunel cuts
  it off the network. Do not rely on "unreachable PAC means direct". Chromium
  refuses `file://` PAC URLs, so do not replace this with a file on disk.
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
- Both windows hide on close. Closing the terminal window also runs
  `Terminals::close_all` and emits `terminal-hidden`, on which the page drops
  every tab; the webview itself survives, so reopening is instant (rebuilding it
  on every open is what made quick close/open lag). After 60 s hidden
  (`schedule_terminal_teardown`, cancelled by a reopen via a generation
  counter) it is destroyed to free memory. `Destroyed` still closes all
  terminals.
- Window shortcuts live in `src/terminal/shortcuts.ts` and xterm is told to
  ignore exactly those keys. Keep them off plain Ctrl+letter: the shell owns
  those (Ctrl+K kill-line, Ctrl+B tmux prefix).
- No key or click may reach the webview's own features. `strayKeyAction`
  cancels unhandled F-keys and Ctrl/Cmd combos (never Ctrl+Alt: AltGr), a
  window mousedown guard keeps clicks on chrome from taking focus off the
  shell, and release builds turn off WebView2's browser accelerator keys
  (`commands::harden_webview`).
- Selection copies on a mouseup watched on the window, not the pane: drags
  usually end past the pane edge.
- Light backgrounds get font weight 500 (`weightsFor`): the WebGL canvas only
  has grayscale antialiasing, which thins dark-on-light text. xterm's
  `minimumContrastRatio: 4.5` lifts faint program colours. `settings.terminal_webgl`
  off disposes the WebGL addon live, falling back to the DOM renderer.
- `MouseGate` (`src/terminal/mouseGate.ts`) swallows the DECSET mouse-tracking
  modes (9/1000/1001/1002/1003) unless `settings.terminalAppMouse` is on, so a
  plain drag always selects even under tmux/vim/htop; xterm turns the wheel
  into arrow keys in the alt screen, so scrolling there still works. Requested
  modes are remembered and replayed when the setting (or the footer chip)
  flips, without waiting for the program to ask again.
- Both windows show tunnels and host-key prompts, so `tunnels-changed` (emit
  via `commands::tunnels_changed`) and `host-key-resolved` keep them in step.
- Suggestions (`settings.terminal_suggestions`) live in `SmartSession`
  (`src/terminal/smartSession.ts`), which `TerminalView` only feeds input,
  output and keys; ghost text is `GhostSuggest` (`ghost.ts`), the chip and Tab
  reminder are `SuggestionChip.tsx`. Keep new terminal smarts there, not in
  `TerminalView`'s effect. `ShellWatcher`
  (`src/terminal/shellWatch.ts`) reads each command off the screen — the line
  at Enter from where typing began — and calls it finished when output goes
  quiet with a line matching the prompt shape learned from the shell's first
  prompt (`smart.ts` `promptShape`; a REPL's prompt doesn't match, so its lines
  aren't commands). OSC 133 marks, when a shell sends them, replace both
  heuristics and add the exit code. `smart.ts` (pure, `tests/smart.test.ts`)
  decides what is remembered (`normalizeCommand` drops secret-looking lines and
  lines starting with a space; a command that fails — exit code, or error
  wording via `commandFailed` — is taken back with `forgetCommand`), the usual
  sequence (commands in ≥40% and ≥2 of the last 10 non-empty shells, in their
  usual order — not an exact shared prefix, habits are never typed identically;
  muted after 3 dismissals) and fixes (`suggestFix`: sudo, typos, hints
  programs print). Chips never take focus and no key runs anything: Alt+Enter
  puts the fix (or a sequence's first command) at the prompt, any other key
  dismisses; only a click on a sequence's Run runs it, one step per prompt,
  stopping on a non-zero exit. Autocomplete (`predictCommand`) draws the rest
  of a remembered command as an xterm decoration after the cursor
  (`ShellWatcher.promptInput`; nothing when text follows the cursor, so
  zsh-autosuggestions/fish win); on a fresh prompt it offers what followed the
  previous command at least twice. Tab stays the shell's; two Tabs in a row
  over a ghost show a "use →" reminder (≤ once per 10 min, never after →
  accepted 3 times, counted in localStorage). → accepts, Ctrl+→ one word — never Alt+arrows,
  which are the window's pane keys (`shortcuts.ts`) and xterm's block-select modifier.
  Chip input goes to that pane only (`terminalWrite`), never broadcast.
  xterm's own replies (`isTerminalReport`) are not typing.
- Long commands (`settings.terminal_long_command_secs`, 0 = off) ending while
  the pane is hidden or the window unfocused raise `terminal_notify` and an
  amber dot on the tab.
- `terminal_memory.json` (`settings::TerminalMemory`, `src/terminal/memory.ts`)
  holds commands per host and workspaces (named sets of layout trees, revived
  with fresh pane ids by `layout.ts` `reviveLayout`; `last-session` is saved on
  `terminal-hidden` and offered as "Restore last session", naming user@host
  when it was one shell). A tab opened from (or added to) a workspace carries
  `Tab.workspaceId`; when the linked tabs' `layoutShape` differs from the saved
  one the save button shows a dot and "Save changes" writes the open linked
  tabs back (a closed one leaves the workspace). Local only: never
  add it to config export — commands can carry secrets.

### Simple mode (`settings.ui_mode`, `access.rs`, `SimpleHome`)

For QA/testers/POs who only browse internal sites through tunnels an
administrator set up. `ui_mode` is `None` until chosen: `ModeChooser` asks on a fresh install and
on the first launch after updating from a version without modes (and before
"What's new" and the tour). Simple mode replaces the tunnel list with one
"Internal network" switch (`set_network_access`): on = router + Windows system
proxy (forced on) + connect the tunnels enabled rules/default route through
(`access::connect_routed`, also run at launch when the router was left on);
off = router stop + every tunnel stopped. The list is read-only and filtered
by `simpleMode.ts` `routedTunnels`; errors are classified (`classifyError`) into
"ask your administrator" wording, raw text only in the tooltip, and the top message bar
stays quiet. Hidden: terminal, router panel, capture, add/edit, tour, known
hosts, the Tunnels/Terminal settings pages. The tray shows one "Internal
network" check item instead of per-tunnel ones (`update_settings` rebuilds it).
An administrator hands out a config exported with "Open in Simple mode" (`ConfigBundle::ui_mode`,
applied on import only when ticked); importing the settings section never
changes the importer's mode. An administrator fixes a tester's machine by switching to
Full under Settings › General — the mode is a UX choice, not a lock.

**Developer tools** (Settings › Developer tools; debug builds or
`PROTUNEL_DEVTOOLS=1`, enforced in Rust by `require_dev_tools`): simulate an
update found/downloaded/failed (`updates::simulate` — a simulated "Restart to
update" really restarts and writes `resume.json`/`whats_new.json` but installs
nothing), show "What's new", re-ask the mode question, and fake a tunnel's
failure (wrong password, unreachable, changed host key via
`KnownHosts::record_fake_mismatch`).

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
  keyed by tunnel UUID. Never in SQLite. Clone and range add (`add_tunnels`)
  copy a secret vault-to-vault via `copy_secret_from`; it never goes to the webview.
- **JSON files** in `app_data_dir` — `settings.json`, `router.json` (both
  `settings.rs`, via the shared `JsonStore<T>`), and `known_hosts.json`
  (`ssh/known_hosts.rs`). New `Settings` fields need `#[serde(default …)]` or
  existing installs fail to deserialize and reset. All of them write through
  `settings::write_atomic` (temp file + rename) and read through
  `settings::load_json`, which moves an unreadable file to `<name>.json.corrupt`
  before falling back to defaults — never plain `fs::write` (a crash mid-write
  would truncate the file, and a truncated `known_hosts.json` silently forgets
  every trusted key). `JsonStore::update` returns the write error: propagate it
  from commands, `update_or_log` only for background bookkeeping. Router config is a
  *separate* store on purpose: the settings panel writes back a whole `Settings`
  object and would otherwise clobber router state edited in the other panel.

### Host-key TOFU

`SshHandler::check_server_key` consults `KnownHosts`; an unknown key emits
`host-key-pending` and *blocks the connection* on a `oneshot` resolved by the
`confirm_host_key`/`reject_host_key` commands (120s timeout, default deny). A stored
key that mismatches is rejected outright. Do not weaken this into auto-trust — it is
the main thing this rewrite fixed versus the old WinForms/plink app.

A mismatch is also recorded in memory (`KnownHosts::record_mismatch`) and emitted as
`host-key-mismatch` (`list_host_key_mismatches` seeds a reload), because the russh
error ("Unknown server key") is the same as a rejected first prompt. The tunnel row
then offers `HostKeyChangedDialog`, which shows both fingerprints and only *forgets*
the old key before reconnecting — the new key still goes through the normal
first-connection prompt. The edit form shows the trusted key with a Forget button;
the full list (`KnownHostsPanel`) is a link on the Settings Backup page.

### Events

Names are declared in `events.rs` (never a string literal at the `emit` call)
and consumed by the hooks in `src/hooks/`:
`tunnel-status`, `tunnel-stats` (1 Hz per connected tunnel), and `host-key-pending`
in `useTunnelEvents.ts`; `router-status` and `router-stats` (1 Hz while running) in
`useRouterEvents.ts`. The routing decision log is *polled* by `RouterPanel`, not
evented — it grows once per proxied connection, which is far too chatty for an event.

### Tray and window

Text Rust shows by itself (tray menu, desktop notifications) goes through
`i18n.rs` (`i18n::t(app, Text::…)`, by `settings.language`) — never a
hard-coded English string; everything the webview draws stays in
`src/locales`. Errors from servers and libraries stay untranslated.

Closing the window hides it (`on_window_event` → `prevent_close` + `hide`); exit is
tray-only. The main window is declared `"visible": false` and shown in `setup`,
unless the app was started by the OS autostart entry (which passes
`commands::AUTOSTART_ARG`) and `settings.start_minimized` is on. `setup` also
rewrites an enabled autostart entry (`refresh_autostart`) so entries from versions
without the argument pick it up. `tray::rebuild_menu` rebuilds the whole menu and is called on every status
transition and every tunnel add/edit/delete — tray checkmarks have no other update path.

The toggle gesture is double-click on Windows, left click on Linux. Linux gets clicks
only because `Cargo.toml` enables tray-icon's `ksni` feature (StatusNotifierItem);
the default AppIndicator backend emits no tray events at all. That dependency must
track the tray-icon minor Tauri uses (0.25 for tauri 2.12), or two copies build and
the feature stops applying.

### Frontend conventions

- Tailwind v4, configured CSS-first in `src/index.css` via `@theme`. Semantic color
  tokens only (`bg-surface`, `text-muted`, `bg-accent`, `bg-coral`) — raw palette
  classes break theming. Text on a coloured button is `text-on-accent` /
  `text-on-coral` / `text-on-amber`, never `text-white`: many themes have light
  accents.
- Themes (`src/themes/`): `palettes.ts` is generated from Monkeytype's GPL-3.0
  theme table (the project is GPL-3.0 for this reason; keep its one-line source
  notice). `index.ts` derives every token plus the xterm ANSI palette from those
  10 colours, enforcing readable contrast, and `useTheme(settings)` writes them as
  CSS variables on `<html>` (overriding the `index.css` defaults) and returns the
  theme. `settings.theme` is a theme id or `"system"` (then `themeLight` /
  `themeDark`); legacy `"light"`/`"dark"` map to the two `protunel_*` themes.
  The picker previews on hover via `setThemePreview`. `settings-changed` keeps
  every window's copy in step (`App`, `SettingsPanel`, `TerminalApp` all
  listen): saves send the whole `Settings` object, so a window holding a stale
  copy would revert another window's change on its next save.
- Dates and times shown to the user go through `format.ts` `formatTimestamp`
  (the app's language, not the OS locale) — never a bare `toLocale*String()`.
- Vietnamese wording follows one glossary: máy chủ, khóa máy chủ, máy chủ đã
  tin cậy, quy tắc, lưu lượng, nhập/xuất cấu hình, tệp, chủ đề, sao chép, ứng
  dụng; capture is "Ứng dụng" on its button and "Ứng dụng qua router" as a
  title; in the terminal pane = khung, broadcast = gõ đồng thời. Kept in
  English: tunnel, SSH, SOCKS5, port forward, passphrase, regex, wildcard,
  tab, workspace, and UI names of other programs (Firefox's settings).
- SSH errors the user can act on (`simpleMode.ts` `plainSshError`: auth,
  unreachable) get plain words in Full mode too — on the tunnel row and in
  the top message bar (prefixed with the tunnel name) — with the server's
  text kept after them (and whole in the row's tooltip).
- Fonts are self-hosted woff2 in `src/assets/fonts` (no CDN; the webview is offline).
- `src/App.tsx` owns tunnel list, settings, and dialog state; child components are
  presentational and call back up. The big panels that replace each other
  (add/edit form, Router, Capture, theme drawer, Settings + page) are one
  `panel` state — the tour opens exactly one; confirmations and prompts stack
  on top as their own state. Search lives in `useTunnelSearch`, restart-to-update
  in `useRestartToUpdate`.
- `SettingsPanel` is one page per subject (General, Tunnels, Terminal, Backup,
  About) with a side list, drawn in a `bare` `Modal` (own frame and close
  button); settings are `Group`/`Row` cards with a `Switch` on the right. Put a
  new option on the page of the thing it changes.
  Backup embeds `ConfigFlow` (export/import) inline: the hub routes to
  `components/config/{ExportView,ImportView,ImportedView}` (shared pieces in
  `config/parts.tsx`); each import pick remounts `ImportView` so its choices
  start over. It listens to
  `settings-changed` so an import can't be overwritten by its stale copy.
- Every modal surface (`Modal`, `Drawer`) uses `useDialogFocus`
  (`src/dialogFocus.ts`): focus moves in on open, Tab wraps inside, focus
  returns on close, and the panel is named by its title (`aria-labelledby`).
  A new overlay with `aria-modal` must use it too, or Tab walks out behind
  the backdrop.
- Right-click menus are native (`src/contextMenu.ts`, Tauri `Menu.popup`), never
  the webview's (Reload, Inspect…). `installContextMenuGuard` (both windows'
  `main.tsx`) blocks the webview menu and gives text fields Cut/Copy/Paste
  (actions restore focus/selection, then `execCommand("insertText")` so React
  sees the change); components open their own with `openMenu` (tunnel rows,
  the empty list, Simple-mode error rows). Dev builds: Shift + right-click
  still opens the webview menu for Inspect.
- `TourGuide` spotlights whatever carries the matching `data-tour="…"` attribute, so
  moving or renaming one silently drops a step back to a centred card. Steps that
  live inside a modal declare a `panel`, and `App.showTourPanel` opens exactly that
  one (`settings:<page>` and `router:<tab>` also pick the page or tab, since
  `RouterPanel` shows Rules / Log / Settings one at a time) — which is why measurement retries on `requestAnimationFrame`: the target does
  not exist until the panel it lives in has mounted.

### Capabilities

`src-tauri/capabilities/default.json` gates what the *frontend* may call. Plugins used
only from Rust (notification, autostart) need no entry; anything invoked from TS does.

## Stack and source layout

Tauri v2 · React 19 · TypeScript · Tailwind CSS v4 · xterm.js · `russh` · `fast-socks5` ·
`rusqlite` · `regex` + `ipnet` · `minhook`. Development needs [Bun](https://bun.sh) and,
on Windows, the [Rust MSVC toolchain](https://www.rust-lang.org/tools/install).

```
src/                React UI — panels, event hooks, typed IPC wrappers
  terminal/          terminal window: panes, tabs, drag-and-drop, broadcast
  themes/            theme catalogue and token derivation
src-tauri/src/
  commands/          every #[tauri::command], one file per subject; the IPC surface
  tunnel.rs          AppState: running tunnels, statuses, router state
  ssh/               per-tunnel supervisor, SOCKS5 + local forwards, TOFU,
                     terminal PTY channels
  router/            rule matcher, listener, Windows system proxy, PAC
  capture/           process launch + hook-DLL injection
  db.rs              SQLite: tunnels, forwards, router rules
  secrets.rs         OS credential vault (keyring)
  settings.rs        JSON-backed settings and router config
```
