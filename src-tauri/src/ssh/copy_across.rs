//! Queued server-to-server copies and direct-route discovery.

use super::*;
use crate::db::Tunnel;
use tokio::sync::OnceCell;

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const FAILED_PROBE_TTL: Duration = Duration::from_secs(60);
const HOST_KEY_ALIAS: &str = "protunel-dest";

// The watchdog handles both explicit cancellation and a lost client (EOF).
// The completion marker is sent only after the child exits and TERM is ignored.
const WATCH_COPY: &str = r#"
marker=$1
shift
exec 3<&0
"$@" </dev/null 3<&- &
child=$!
trap 'kill -TERM "$child" 2>/dev/null; wait "$child"; exit 143' TERM HUP
(if ! IFS= read -r request || [ "$request" = cancel ]; then kill -TERM "$$"; fi) <&3 >/dev/null 2>&1 &
watcher=$!
exec 3<&-
wait "$child"
status=$?
trap '' TERM HUP
printf '\n%s\n' "$marker"
wait "$watcher"
exit "$status"
"#;

#[derive(Default)]
pub(super) struct Probes(Mutex<HashMap<(Uuid, Uuid), CachedProbe>>);

struct CachedProbe {
    endpoint: (String, String, u16),
    key: String,
    session: Weak<Handle>,
    result: Arc<ProbeResult>,
}

type ProbeResult = OnceCell<(bool, Instant)>;

fn probe_is_fresh(now: Instant, reachable: bool, checked_at: Instant) -> bool {
    reachable || now.duration_since(checked_at) < FAILED_PROBE_TTL
}

impl Probes {
    async fn reachable(
        &self,
        pair: (Uuid, Uuid),
        session: &Arc<Handle>,
        sftp: &SftpSession,
        tunnel: &Tunnel,
        key: &str,
    ) -> Option<Arc<ProbeResult>> {
        let endpoint = (tunnel.username.clone(), tunnel.host.clone(), tunnel.port);
        let session_id = Arc::downgrade(session);
        let result = {
            let mut probes = self.0.lock().unwrap();
            let new_probe = || CachedProbe {
                endpoint: endpoint.clone(),
                key: key.to_owned(),
                session: session_id.clone(),
                result: Arc::new(OnceCell::new()),
            };
            let probe = probes.entry(pair).or_insert_with(&new_probe);
            let fresh = probe.result.get().is_none_or(|&(reachable, checked_at)| {
                probe_is_fresh(Instant::now(), reachable, checked_at)
            });
            if probe.endpoint != endpoint
                || probe.key != key
                || !probe.session.ptr_eq(&session_id)
                || !fresh
            {
                *probe = new_probe();
            }
            probe.result.clone()
        };
        let reachable = result
            .get_or_init(|| async {
                let reachable = if let Ok(path) = write_known_host(sftp, key).await {
                    let reachable = succeeds(session, &probe_command(tunnel, &path)).await;
                    let _ = sftp.remove_file(path).await;
                    reachable
                } else {
                    false
                };
                (reachable, Instant::now())
            })
            .await
            .0;
        reachable.then_some(result)
    }

    fn invalidate(&self, pair: (Uuid, Uuid), result: &Arc<ProbeResult>) {
        let mut probes = self.0.lock().unwrap();
        if probes
            .get(&pair)
            .is_some_and(|probe| Arc::ptr_eq(&probe.result, result))
        {
            probes.remove(&pair);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyAcross {
    pub route: Route,
    pub transfer_ids: Vec<Uuid>,
    pub key_hint: Option<String>,
}

struct CopyBatch {
    from: Uuid,
    to: Uuid,
    source_session: Arc<Handle>,
    dest_session: Arc<Handle>,
    tunnel: Tunnel,
    dest_dir: String,
    conflict: Conflict,
    pin: Option<(String, Arc<ProbeResult>)>,
    /// The endpoints A and B reached when the copy was asked for.
    endpoints: (Option<String>, Option<String>),
    /// A retry: what the earlier run(s) finished, and whether they made the
    /// target (`JobMeta`).
    placed: Placed,
    owns: bool,
}

pub async fn copy_across(
    app: &AppHandle,
    state: &AppState,
    from: Uuid,
    sources: Vec<String>,
    to: Uuid,
    dest_dir: String,
    conflict: Conflict,
    // The name on B, for a single source (a retry of a "keep both" copy).
    target_name: Option<String>,
    // The endpoints the panels showed (or a retried job ran against; A in
    // `endpoint`, B in `dest_endpoint`): a host edited since to reach
    // another server refuses the copy. A retry also brings `placed`/`owns`.
    prior: JobMeta,
) -> Result<CopyAcross, String> {
    let expect = (prior.endpoint.clone(), prior.dest_endpoint.clone());
    if from == to {
        return Err("same-tunnel".to_string());
    }
    let source_session = live_session(state, from)?;
    let dest_session = live_session(state, to)?;
    let endpoints = (endpoint_now(app, from), endpoint_now(app, to));
    let moved = |want: &Option<String>, now: &Option<String>| want.is_some() && want != now;
    if moved(&expect.0, &endpoints.0) || moved(&expect.1, &endpoints.1) {
        return Err("target-changed".to_string());
    }
    let tunnel = state
        .db
        .get(to)
        .map_err(|e| e.to_string())?
        .ok_or("not-connected")?;
    // The direct routes dial B by the saved host and pin its saved key: the
    // record must still describe the server the live session reached (a
    // host edited but not reconnected yet does not).
    if endpoints.1.as_ref().is_some_and(|now| *now != format!("{}@{}:{}", tunnel.username, tunnel.host, tunnel.port)) {
        return Err("target-changed".to_string());
    }
    let mut names: Vec<&str> = sources.iter().map(|s| split(s.trim_end_matches('/')).1).collect();
    names.sort_unstable();
    if names.windows(2).any(|w| w[0] == w[1]) {
        return Err("duplicate-names".to_string());
    }
    let mut pin = None;
    let mut jobs: Vec<_> = sources
        .into_iter()
        .map(|source| (source, Route::Relay))
        .collect();
    let mut route = Route::Relay;
    if let Some(key) = state
        .known_hosts
        .openssh_key(&format!("{}:{}", tunnel.host, tunnel.port))
    {
        if let Ok(sftp) = sftp_for_session(app, from, &source_session).await {
            let files = app.state::<Files>();
            if let Some(probe) = files
                .copy_probes
                .reachable((from, to), &source_session, &sftp, &tunnel, &key)
                .await
            {
                pin = Some((key, probe));
                let (rsync_a, rsync_b) = tokio::join!(
                    succeeds(&source_session, "command -v rsync"),
                    succeeds(&dest_session, "command -v rsync"),
                );
                for (source, job_route) in &mut jobs {
                    *job_route = if rsync_a && rsync_b {
                        Route::Rsync
                    } else if regular_source(&sftp, source.trim_end_matches('/')).await {
                        Route::Scp
                    } else {
                        Route::Relay
                    };
                    if *job_route != Route::Relay {
                        route = *job_route;
                    }
                }
            }
        }
    }
    let key_hint = if pin.is_some() {
        None
    } else {
        let check_key = shell_command([
            "sh",
            "-c",
            r#"for key in "$HOME"/.ssh/id_*.pub; do [ -f "$key" ] && exit 0; done; exit 1"#,
        ]);
        let has_key = succeeds(&source_session, &check_key).await;
        key_hint_command(&tunnel, has_key)
    };

    let batch = Arc::new(CopyBatch {
        from,
        to,
        source_session,
        dest_session,
        tunnel,
        dest_dir,
        conflict,
        pin,
        endpoints,
        placed: prior.placed,
        owns: prior.owns,
    });
    batch.ensure_live(state)?;
    let single = jobs.len() == 1;
    let transfer_ids = jobs
        .into_iter()
        .map(|(source, route)| {
            let name = target_name.clone().filter(|n| single && valid_name(n));
            batch.clone().queue(app, source, name, route)
        })
        .collect();
    Ok(CopyAcross {
        route,
        transfer_ids,
        key_hint,
    })
}

fn live_session(state: &AppState, id: Uuid) -> Result<Arc<Handle>, String> {
    state
        .session_for(id)
        .filter(|session| !session.is_closed())
        .ok_or_else(|| "not-connected".to_string())
}

async fn succeeds(session: &Handle, command: &str) -> bool {
    exec(session, command, PROBE_TIMEOUT)
        .await
        .is_ok_and(|out| out.status == Some(0))
}

impl CopyBatch {
    fn ensure_live(&self, state: &AppState) -> Result<(), String> {
        // A queued job belongs to the connections present when the route was chosen.
        if !Arc::ptr_eq(&live_session(state, self.from)?, &self.source_session)
            || !Arc::ptr_eq(&live_session(state, self.to)?, &self.dest_session)
        {
            return Err("not-connected".to_string());
        }
        Ok(())
    }

    fn queue(self: Arc<Self>, app: &AppHandle, source: String, target_name: Option<String>, route: Route) -> Uuid {
        let name = target_name.clone().unwrap_or_else(|| split(&source).1.to_string());
        let transfer = Transfer {
            id: Uuid::new_v4(),
            tunnel_id: self.from,
            dest_tunnel_id: Some(self.to),
            direction: Direction::Copy,
            route: Some(route),
            name: name.to_string(),
            remote_path: source.clone(),
            local_path: self.dest_dir.clone(),
            done: 0,
            total: 0,
            state: TransferState::Queued,
            error: None,
            open_when_done: false,
            files_done: 0,
            files_failed: 0,
            failures: Vec::new(),
            endpoint: None,
            dest_endpoint: None,
        };
        let meta = JobMeta {
            conflict: Some(self.conflict),
            endpoint: self.endpoints.0.clone(),
            dest_endpoint: self.endpoints.1.clone(),
            placed: self.placed.clone(),
            owns: self.owns,
        };
        spawn(app, transfer, meta, move |ctx| {
            Box::pin(async move {
                match self.run(&ctx, &source, target_name.as_deref(), route).await {
                    Err(e) if e == "exists" => {
                        ctx.skipped.store(true, Ordering::Relaxed);
                        Ok(())
                    }
                    result => result,
                }
            })
        })
    }

    async fn run(&self, ctx: &Ctx, source: &str, target_name: Option<&str>, route: Route) -> Result<(), String> {
        let source = source.trim_end_matches('/');
        let source_name = split(source).1;
        let name = target_name.unwrap_or(source_name);
        if !valid_name(name) || !valid_name(source_name) || source.contains('\0') || self.dest_dir.contains('\0') {
            return Err("invalid-path".to_string());
        }
        self.ensure_live(&ctx.app.state::<AppState>())?;
        ctx.check()?;
        let dest = sftp_for_session(&ctx.app, self.to, &self.dest_session).await?;
        let dest_dir = dest
            .canonicalize(self.dest_dir.as_str())
            .await
            .map_err(err)?;
        let mut target = join(&dest_dir, name);
        let mut mode = match (exists(&dest, &target).await?, self.conflict) {
            (false, _) => Write::New,
            (true, Conflict::Skip) => return Err("exists".to_string()),
            (true, Conflict::Replace) => Write::Replace,
            (true, Conflict::Resume) => Write::Resume,
            (true, Conflict::KeepBoth) => {
                target = free_remote(ctx, self.to, &dest, &dest_dir, name).await?;
                let transfer = {
                    let mut transfer = ctx.transfer.lock().unwrap();
                    transfer.name = split(&target).1.to_string();
                    transfer.clone()
                };
                publish(&ctx.app, &transfer);
                Write::New
            }
        };
        // A name taken between the check and the copy: "keep both" moves on
        // to the next free one; anything else ends as skipped.
        for _ in 0..5 {
            match self.copy_into(ctx, source, source_name, &dest, &dest_dir, &target, mode, route).await {
                Err(e) if e == "exists" && self.conflict == Conflict::KeepBoth => {
                    target = free_remote(ctx, self.to, &dest, &dest_dir, name).await?;
                    let transfer = {
                        let mut transfer = ctx.transfer.lock().unwrap();
                        transfer.name = split(&target).1.to_string();
                        transfer.clone()
                    };
                    publish(&ctx.app, &transfer);
                    mode = Write::New;
                }
                other => return other,
            }
        }
        Err("exists".to_string())
    }

    #[allow(clippy::too_many_arguments)]
    async fn copy_into(
        &self,
        ctx: &Ctx,
        source: &str,
        source_name: &str,
        dest: &SftpSession,
        dest_dir: &str,
        target: &str,
        mode: Write,
        mut route: Route,
    ) -> Result<(), String> {
        // rsync writes `dir/<source name>`: a different target name (keep
        // both, or its retry) goes through a stage and a rename instead.
        let renamed = split(target).1 != source_name;
        let a = sftp_for_session(&ctx.app, self.from, &self.source_session).await?;
        // One policy for links on every route: a top-level link is refused
        // (relay would copy nothing, rsync/scp the link or its target).
        let source_attrs = a.symlink_metadata(source).await.map_err(|e| at(source, e))?;
        if source_attrs.is_symlink() || !(source_attrs.is_dir() || source_attrs.is_regular()) {
            return Err("not-copied-link".to_string());
        }
        let single = source_attrs.is_regular();
        if single && already_done(ctx, dest, target, mode).await? {
            ctx.file_done();
            return Ok(());
        }
        if route == Route::Scp && !regular_source(&a, source).await {
            route = Route::Relay;
            let transfer = {
                let mut transfer = ctx.transfer.lock().unwrap();
                transfer.route = Some(route);
                transfer.clone()
            };
            publish(&ctx.app, &transfer);
        }
        // rsync merges only under the source's own name. A retry of a
        // Replace goes by relay too: it skips what the earlier run finished,
        // where rsync would replace those files again.
        if route == Route::Rsync && mode != Write::New && (renamed || (mode == Write::Replace && ctx.placed_any())) {
            route = Route::Relay;
        }
        if route == Route::Relay {
            return relay(ctx, &a, dest, source, target, mode).await;
        }

        let (key, probe) = self
            .pin
            .as_ref()
            .expect("direct routes require a pinned key");
        ctx.check()?;
        let known_hosts = write_known_host(&a, key).await?;
        // Files rsync reports finished (`--out-format`), as paths under the
        // folder it copied into; recorded once they are in place.
        let mut copied: Vec<String> = Vec::new();
        let result = match route {
            // Replace merges into what is there (files replaced), as an
            // upload does; Resume merges keeping every file already there.
            Route::Rsync if mode != Write::New => {
                let marker = completion_marker();
                let command = rsync_command(
                    &self.tunnel,
                    source,
                    dest_dir,
                    mode == Write::Replace,
                    &marker,
                    &known_hosts,
                );
                let r = run_direct(ctx, &self.source_session, &command, &marker, true, &mut copied).await;
                // rsync renames each file into place as it finishes.
                if r.is_ok() || r.as_ref().is_err_and(rsync_partial) {
                    place_rsync(ctx, target, &copied);
                }
                // Went on past files it could not copy: those are the
                // job's failures, the rest is in place.
                match r {
                    Err(e) if rsync_partial(&e) => rsync_failures(ctx, &e.message),
                    other => other,
                }
            }
            // Otherwise each job copies into a stage of its own, published
            // with a no-replace rename: two copies of one name never mix,
            // and a cancelled one leaves nothing under the final name.
            Route::Rsync => {
                self.staged(ctx, dest, source, target, false, true, &mut copied, |stage, marker| {
                    rsync_command(&self.tunnel, source, stage, false, marker, &known_hosts)
                })
                .await
            }
            Route::Scp => {
                self.staged(ctx, dest, source, target, mode == Write::Replace, false, &mut copied, |stage, marker| {
                    scp_command(&self.tunnel, source, stage, marker, &known_hosts)
                })
                .await
            }
            Route::Relay => unreachable!(),
        };
        if result.is_ok() && single && ctx.placed_at(target).is_none() {
            ctx.placed(target, target, true);
        }
        if result.as_ref().is_err_and(|e| e.status == Some(255)) {
            ctx.app
                .state::<Files>()
                .copy_probes
                .invalidate((self.from, self.to), probe);
        }
        let _ = a.remove_file(known_hosts).await;
        result.map_err(|e| e.message)
    }

    /// Runs a direct copy into a fresh stage folder on B, then renames the
    /// copied entry to `target` (`commit_part`) and removes the stage.
    async fn staged(
        &self,
        ctx: &Ctx,
        dest: &SftpSession,
        source: &str,
        target: &str,
        overwrite: bool,
        rsync: bool,
        copied: &mut Vec<String>,
        command: impl FnOnce(&str, &str) -> String,
    ) -> Result<(), DirectError> {
        ctx.check()?;
        let stage = join(
            split(target).0,
            &format!(".{}.protunel-part", Uuid::new_v4().simple()),
        );
        dest.create_dir(stage.as_str())
            .await
            .map_err(|e| at(&stage, e))?;
        let marker = completion_marker();
        let command = command(&stage, &marker);
        let result = run_direct(ctx, &self.source_session, &command, &marker, rsync, copied).await;
        let result = match result {
            Err(mut e) if e.exit_unconfirmed => {
                e.message = format!(
                    "{}; copy exit unconfirmed, staging folder left at {stage}",
                    e.message
                );
                return Err(e);
            }
            // rsync copied all it could (23, 24): publish that, so a retry
            // only fetches the rest; the failures go on the job.
            // If it made nothing at all, rsync's own words say why.
            Err(e) if rsync && rsync_partial(&e) => {
                let staged = join(&stage, split(source).1);
                match commit_part(ctx, dest, &staged, target, overwrite).await {
                    Ok(()) => {
                        ctx.own();
                        place_rsync(ctx, target, copied);
                        rsync_failures(ctx, &e.message)
                    }
                    Err(_) => Err(e),
                }
            }
            Err(e) => Err(e),
            Ok(()) => {
                let staged = join(&stage, split(source).1);
                let r = commit_part(ctx, dest, &staged, target, overwrite).await;
                if r.is_ok() {
                    if !overwrite {
                        ctx.own();
                    }
                    place_rsync(ctx, target, copied);
                }
                r.map_err(DirectError::from)
            }
        };
        let cleanup = delete_tree(dest, &stage, true).await;
        result.and(cleanup.map_err(DirectError::from))
    }
}

/// rsync went on past files it could not copy (exit 23, 24), and said so
/// for certain (exit confirmed).
fn rsync_partial(e: &DirectError) -> bool {
    matches!(e.status, Some(23 | 24)) && !e.exit_unconfirmed
}

/// Prefix of the line `--out-format` prints for each file rsync copied.
const RSYNC_FILE: &str = "protunel-file:";

/// Records the files rsync reported (`copied`, names relative to the folder
/// it copied into, led by the source's name) under `target`.
fn place_rsync(ctx: &Ctx, target: &str, copied: &[String]) {
    for name in copied.iter().filter(|n| !n.ends_with('/')) {
        let path = match name.split_once('/') {
            Some((_, rest)) if !rest.is_empty() => join(target, rest),
            _ => target.to_string(),
        };
        if ctx.placed_at(&path).is_none() {
            ctx.placed(&path, &path, true);
        }
    }
}

/// Notes each distinct "rsync: …" line of a partial rsync run as a failed
/// entry (rsync's closing "rsync error: …" summary is not one).
fn rsync_failures(ctx: &Ctx, stderr: &str) -> Result<(), DirectError> {
    let mut any = false;
    let mut seen = std::collections::HashSet::new();
    for line in stderr.lines().filter(|l| l.starts_with("rsync: ")) {
        any = true;
        if seen.insert(line) {
            ctx.entry("", Err(line.trim_start_matches("rsync: ").to_string()))?;
        }
    }
    if !any {
        let line = stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or("copy-failed");
        ctx.entry("", Err(line.to_string()))?;
    }
    Ok(())
}

async fn regular_source(sftp: &SftpSession, source: &str) -> bool {
    valid_name(split(source).1)
        && sftp
            .symlink_metadata(source)
            .await
            .is_ok_and(|attrs| attrs.is_regular())
}

async fn write_known_host(sftp: &SftpSession, key: &str) -> Result<String, String> {
    if key.is_empty() || key.chars().any(char::is_control) {
        return Err("invalid trusted host key".into());
    }
    let path = format!("/tmp/protunel-kh-{}", Uuid::new_v4().simple());
    let mut file = sftp
        .open_with_flags_and_attributes(
            path.as_str(),
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            FileAttributes {
                permissions: Some(0o600),
                ..FileAttributes::empty()
            },
        )
        .await
        .map_err(|e| at(&path, e))?;
    let line = format!("{HOST_KEY_ALIAS} {key}\n");
    let result = file.write_all(line.as_bytes()).await;
    let closed = file.close().await;
    if let Err(e) = result.and(closed) {
        let _ = sftp.remove_file(path).await;
        return Err(e.to_string());
    }
    Ok(path)
}

fn valid_name(name: &str) -> bool {
    !matches!(name, "" | "." | "..") && !name.contains(['/', '\0'])
}

fn shell_command<'a>(args: impl IntoIterator<Item = &'a str>) -> String {
    args.into_iter().map(quote).collect::<Vec<_>>().join(" ")
}

fn ssh_options(user_known_hosts: &str) -> Vec<String> {
    // `-F /dev/null`: none of A's ssh config (~/.ssh/config, /etc/ssh/ssh_config)
    // applies, so nothing there (a KnownHostsCommand, a Host alias, a
    // ProxyCommand) can widen the pinned check or send the data elsewhere.
    // Every OpenSSH version accepts it.
    let config = ["-F".to_string(), "/dev/null".to_string()];
    config.into_iter().chain([
        "BatchMode=yes".into(),
        "ConnectTimeout=5".into(),
        format!("UserKnownHostsFile={user_known_hosts}"),
        "GlobalKnownHostsFile=/dev/null".into(),
        "StrictHostKeyChecking=yes".into(),
        format!("HostKeyAlias={HOST_KEY_ALIAS}"),
        // No KnownHostsCommand=none: it needs OpenSSH 8.5+, and older ssh
        // (RHEL/CentOS 7–8) refuses the unknown option, so every probe would
        // fail and the direct route would never be used. The pinned files
        // above already decide the check.
        "VerifyHostKeyDNS=no".into(),
        "ControlPath=none".into(),
    ]
    .into_iter()
    .flat_map(|option| ["-o".into(), option]))
    .collect()
}

fn probe_command(tunnel: &Tunnel, known_hosts: &str) -> String {
    let port = tunnel.port.to_string();
    let login = format!("{}@{}", tunnel.username, tunnel.host);
    let options = ssh_options(known_hosts);
    shell_command(
        ["ssh"]
            .into_iter()
            .chain(options.iter().map(String::as_str))
            .chain(["-p", &port, "--", &login, "true"]),
    )
}

fn key_hint_command(tunnel: &Tunnel, has_key: bool) -> Option<String> {
    if [&tunnel.username, &tunnel.host]
        .into_iter()
        .any(|value| value.chars().any(|c| c.is_control() || c.is_whitespace()))
    {
        return None;
    }
    let prefix = if has_key {
        ""
    } else {
        "ssh-keygen -t ed25519 && "
    };
    let hint = format!(
        "{prefix}ssh-copy-id -p {} {}@{}",
        tunnel.port,
        quote(&tunnel.username),
        quote(&tunnel.host)
    );
    assert!(!hint.chars().any(char::is_control));
    Some(hint)
}

fn remote_dir(tunnel: &Tunnel, dir: &str) -> String {
    let host = &tunnel.host;
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.clone()
    };
    format!("{}@{host}:{}", tunnel.username, join(dir, ""))
}

fn local_source(source: &str) -> String {
    if source.starts_with('/') {
        source.to_string()
    } else {
        format!("./{source}")
    }
}

fn completion_marker() -> String {
    format!("protunel-copy-done-{}", Uuid::new_v4().simple())
}

fn rsync_command(
    tunnel: &Tunnel,
    source: &str,
    dir: &str,
    overwrite: bool,
    marker: &str,
    known_hosts: &str,
) -> String {
    let options = ssh_options(known_hosts);
    let port = tunnel.port.to_string();
    let transport = shell_command(
        ["ssh"]
            .into_iter()
            .chain(options.iter().map(String::as_str))
            .chain(["-p", &port]),
    );
    let source = local_source(source);
    let dest = remote_dir(tunnel, dir);
    let mut args = vec![
        "sh",
        "-c",
        WATCH_COPY,
        "protunel-copy",
        marker,
        "env",
        "LC_ALL=C",
        "rsync",
        "-a",
        // Links are not copied, as by the relay.
        "--no-links",
    ];
    // One line per file copied, so a partial run knows what is in place.
    let out_format = format!("--out-format={RSYNC_FILE}%n");
    args.push(&out_format);
    args.push(if overwrite {
        "--ignore-times"
    } else {
        "--ignore-existing"
    });
    // Secluded args carry the destination path over the rsync protocol.
    args.extend([
        "--info=progress2",
        "-s",
        "-e",
        &transport,
        "--",
        &source,
        &dest,
    ]);
    shell_command(args)
}

fn scp_command(
    tunnel: &Tunnel,
    source: &str,
    dir: &str,
    marker: &str,
    known_hosts: &str,
) -> String {
    let source = local_source(source);
    let dest = remote_dir(tunnel, dir);
    let port = tunnel.port.to_string();
    let options = ssh_options(known_hosts);
    let mut args = vec!["sh", "-c", WATCH_COPY, "protunel-copy", marker, "scp", "-p"];
    // Older scp defaults to a remote shell. Require SFTP mode for paths
    // that cannot be passed verbatim to that shell.
    if !dir
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b))
    {
        args.push("-s");
    }
    args.extend(options.iter().map(String::as_str));
    args.extend(["-P", &port, "--", &source, &dest]);
    shell_command(args)
}

struct DirectError {
    message: String,
    status: Option<u32>,
    exit_unconfirmed: bool,
}

impl From<String> for DirectError {
    fn from(message: String) -> Self {
        Self {
            message,
            status: None,
            exit_unconfirmed: false,
        }
    }
}

enum DirectExit {
    Status(u32),
    Signal,
}

impl DirectExit {
    fn status(&self) -> Option<u32> {
        match *self {
            Self::Status(status) => Some(status),
            Self::Signal => None,
        }
    }
}

async fn run_direct(
    ctx: &Ctx,
    session: &Handle,
    command: &str,
    marker: &str,
    progress: bool,
    copied: &mut Vec<String>,
) -> Result<(), DirectError> {
    ctx.check()?;
    let mut channel = tokio::select! {
        biased;
        _ = ctx.cancel.cancelled() => return Err("cancelled".to_string().into()),
        channel = session.channel_open_session() => channel.map_err(|e| e.to_string())?,
    };
    if let Err(e) = ctx.check() {
        let _ = channel.close().await;
        return Err(e.into());
    }
    if let Err(e) = channel.exec(true, command).await {
        let _ = channel.close().await;
        return Err(DirectError {
            exit_unconfirmed: true,
            ..e.to_string().into()
        });
    }

    let mut stderr = Vec::new();
    let mut line = Vec::new();
    let exit = loop {
        let msg = tokio::select! {
            biased;
            _ = ctx.cancel.cancelled() => {
                let exit = tokio::time::timeout(Duration::from_secs(5), async {
                    let _ = channel.data_bytes("cancel\n").await;
                    let _ = channel.eof().await;
                    wait_for_exit(&mut channel).await
                }).await.ok().flatten();
                let _ = channel.close().await;
                return Err(DirectError {
                    message: "cancelled".into(),
                    status: exit.as_ref().and_then(DirectExit::status),
                    exit_unconfirmed: exit.is_none(),
                });
            }
            msg = channel.wait() => msg,
        };
        match msg {
            Some(ChannelMsg::Data { data }) => {
                for &byte in data.iter() {
                    if matches!(byte, b'\r' | b'\n') {
                        if line == marker.as_bytes() {
                            let _ = channel.eof().await;
                        } else if let Some(name) = line.strip_prefix(RSYNC_FILE.as_bytes()) {
                            // A name cut at the length limit is left out
                            // (that file is only copied again on a retry).
                            if line.len() < 4096 {
                                copied.push(String::from_utf8_lossy(name).into_owned());
                            }
                        } else if progress {
                            update_progress(ctx, &line);
                        }
                        line.clear();
                    } else if line.len() < 4096 {
                        line.push(byte);
                    }
                }
            }
            Some(ChannelMsg::ExtendedData { data, .. }) => {
                let room = 8192 - stderr.len();
                stderr.extend_from_slice(&data[..data.len().min(room)]);
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                break Some(DirectExit::Status(exit_status))
            }
            Some(ChannelMsg::ExitSignal { .. }) => break Some(DirectExit::Signal),
            Some(ChannelMsg::Failure) | None => break None,
            _ => {}
        }
    };
    let _ = channel.close().await;
    if progress {
        update_progress(ctx, &line);
    }
    let status = exit.as_ref().and_then(DirectExit::status);
    if status == Some(0) {
        let done = ctx.done.load(Ordering::Relaxed);
        ctx.set_total(done);
        return Ok(());
    }
    let out = ExecOutput {
        stdout: Vec::new(),
        stderr,
        status,
    };
    Err(DirectError {
        message: stderr_or(&out, "copy-failed"),
        status,
        exit_unconfirmed: exit.is_none(),
    })
}

async fn wait_for_exit(channel: &mut russh::Channel<client::Msg>) -> Option<DirectExit> {
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::ExitStatus { exit_status } => return Some(DirectExit::Status(exit_status)),
            ChannelMsg::ExitSignal { .. } => return Some(DirectExit::Signal),
            _ => {}
        }
    }
    None
}

fn parse_progress2(line: &str) -> Option<(u64, Option<u64>)> {
    let mut fields = line.split_whitespace();
    let bytes = fields.next()?;
    let done: u64 = bytes
        .strip_suffix('B')
        .unwrap_or(bytes)
        .replace(',', "")
        .parse()
        .ok()?;
    let percent: u64 = fields.next()?.strip_suffix('%')?.parse().ok()?;
    if percent > 100 || !fields.next()?.ends_with("/s") || !fields.next()?.contains(':') {
        return None;
    }
    // Progress2 exposes a rounded percentage, so this is an estimate until EOF.
    let total = (u128::from(done) * 100)
        .checked_div(u128::from(percent))
        .map(|total| total.min(u128::from(u64::MAX)) as u64);
    Some((done, total))
}

fn update_progress(ctx: &Ctx, line: &[u8]) {
    if let Some((done, total)) = std::str::from_utf8(line).ok().and_then(parse_progress2) {
        ctx.done.store(done, Ordering::Relaxed);
        if let Some(total) = total {
            ctx.set_total(total);
        }
        ctx.publish_progress(done);
    }
}

/// Most entries one relay copies: the source is walked whole before
/// anything is created on B.
const MAX_RELAY_ENTRIES: usize = 100_000;

enum Planned {
    Dir(String, Option<u32>),
    File(String, String),
}

/// Walks the source on A completely first, so a destination inside the
/// source (two tunnels reaching one machine) can never feed the copy its own
/// output. Symlinks and special files are counted, not followed.
async fn plan_relay(
    ctx: &Ctx,
    a: &SftpSession,
    source: &str,
    target: &str,
    attrs: &FileAttributes,
) -> Result<(Vec<Planned>, u64, usize), String> {
    let mut plan = Vec::new();
    let mut total = 0;
    let mut skipped = 0;
    if !attrs.is_dir() {
        total = attrs.size.unwrap_or(0);
        plan.push(Planned::File(source.to_string(), target.to_string()));
        return Ok((plan, total, skipped));
    }
    let mut stack = vec![(source.to_string(), target.to_string(), attrs.permissions)];
    while let Some((source, target, mode)) = stack.pop() {
        ctx.check()?;
        plan.push(Planned::Dir(target.clone(), mode));
        let items = match a.read_dir(&source).await {
            Ok(items) => items,
            Err(e) if plan.len() == 1 => return Err(at(&source, e)),
            Err(e) => {
                // A subfolder that can't be read: noted, its siblings go on.
                ctx.entry(&source, Err(at(&source, e)))?;
                continue;
            }
        };
        for item in items {
            let name = item.file_name();
            if !valid_name(&name) {
                continue;
            }
            if plan.len() + stack.len() >= MAX_RELAY_ENTRIES {
                return Err("too-many-files".to_string());
            }
            let meta = item.metadata();
            let (from, to) = (join(&source, &name), join(&target, &name));
            if meta.is_dir() && !meta.is_symlink() {
                stack.push((from, to, meta.permissions));
            } else if meta.is_regular() {
                total += meta.size.unwrap_or(0);
                plan.push(Planned::File(from, to));
            } else {
                skipped += 1;
            }
        }
    }
    Ok((plan, total, skipped))
}

async fn relay(
    ctx: &Ctx,
    a: &SftpSession,
    b: &SftpSession,
    source: &str,
    target: &str,
    mode: Write,
) -> Result<(), String> {
    let attrs = a
        .symlink_metadata(source)
        .await
        .map_err(|e| at(source, e))?;
    if !attrs.is_dir() && !attrs.is_regular() {
        // A link would copy as nothing: say so instead of "done".
        return Err("not-copied-link".to_string());
    }
    let (plan, total, skipped) = plan_relay(ctx, a, source, target, &attrs).await?;
    ctx.set_total(total);

    // New folders stay writable until their children are in; their modes
    // are applied last, deepest first. A subfolder that can't be made is
    // noted and everything under it left out.
    let mut modes = Vec::new();
    let mut broken: Vec<String> = Vec::new();
    let under_broken = |path: &str, broken: &[String]| broken.iter().any(|b| path.starts_with(&format!("{b}/")));
    let mut root = true;
    for step in plan {
        ctx.check()?;
        match step {
            Planned::Dir(target, mode_bits) => {
                if under_broken(&target, &broken) {
                    continue;
                }
                let made: Result<(), String> = async {
                    match b.symlink_metadata(target.as_str()).await {
                        Ok(attrs) if (mode != Write::New || !root) && attrs.is_dir() && !attrs.is_symlink() => Ok(()),
                        Ok(_) if mode == Write::New && root => Err("exists".to_string()),
                        Ok(_) => Err(format!("{target}: not a folder")),
                        Err(e) if is_missing(&e) => {
                            if let Err(e) = b.create_dir(target.as_str()).await {
                                if mode == Write::New && root && exists(b, &target).await? {
                                    return Err("exists".to_string());
                                }
                                return Err(at(&target, e));
                            }
                            if let Some(bits) = mode_bits {
                                modes.push((target.clone(), bits));
                            }
                            Ok(())
                        }
                        Err(e) => Err(at(&target, e)),
                    }
                }
                .await;
                if root {
                    made?;
                } else if made.is_err() {
                    ctx.entry(&target, made)?;
                    broken.push(target.clone());
                }
                root = false;
            }
            Planned::File(source, target) => {
                if under_broken(&target, &broken) {
                    continue;
                }
                // Recheck: the file may have changed since it was listed.
                let current = match a.symlink_metadata(source.as_str()).await {
                    Ok(current) if current.is_regular() => current,
                    Ok(_) => continue,
                    Err(e) if is_missing(&e) => continue,
                    Err(e) => {
                        ctx.entry(&source, Err(at(&source, e)))?;
                        continue;
                    }
                };
                match already_done(ctx, b, &target, mode).await {
                    Ok(true) => {
                        ctx.file_done();
                        continue;
                    }
                    Ok(false) => {}
                    Err(e) if root => return Err(e),
                    Err(e) => {
                        ctx.entry(&target, Err(e))?;
                        continue;
                    }
                }
                let r = relay_file(ctx, a, b, &source, &target, &current, mode == Write::Replace).await;
                if r.is_ok() {
                    ctx.placed(&target, &target, true);
                }
                if root {
                    // A single file: its failure is the transfer's.
                    r?;
                } else {
                    ctx.entry(&target, r)?;
                }
            }
        }
    }
    for (target, mode) in modes.into_iter().rev() {
        let attrs = FileAttributes {
            permissions: Some(mode & 0o7777),
            ..FileAttributes::empty()
        };
        let _ = b.set_metadata(target.as_str(), attrs).await;
    }
    if skipped > 0 {
        ctx.transfer.lock().unwrap().error = Some(format!("skipped-links:{skipped}"));
    }
    Ok(())
}

async fn relay_file(
    ctx: &Ctx,
    a: &SftpSession,
    b: &SftpSession,
    source: &str,
    target: &str,
    attrs: &FileAttributes,
    overwrite: bool,
) -> Result<(), String> {
    let mut src = a.open(source).await.map_err(|e| at(source, e))?;
    let part = format!("{target}.{}.protunel-part", short_id());
    let mut dst = b
        .open_with_flags(
            part.as_str(),
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
        )
        .await
        .map_err(|e| at(target, e))?;
    let mut buf = vec![0u8; CHUNK];
    let result = async {
        loop {
            ctx.check()?;
            let n = src
                .read(&mut buf)
                .await
                .map_err(|e| format!("{source}: {}", remote_io(e)))?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n])
                .await
                .map_err(|e| format!("{target}: {}", remote_io(e)))?;
            ctx.advance(n as u64);
        }
        dst.shutdown().await.map_err(|e| format!("{target}: {}", remote_io(e)))
    }
    .await;
    drop(dst);
    let _ = src.close().await;
    let result = match result {
        Ok(()) => {
            let metadata = FileAttributes {
                permissions: attrs.permissions.map(|mode| mode & 0o7777),
                atime: attrs.atime,
                mtime: attrs.mtime,
                ..FileAttributes::empty()
            };
            let _ = b.set_metadata(part.as_str(), metadata).await;
            commit_part(ctx, b, &part, target, overwrite).await
        }
        Err(e) => Err(e),
    };
    if result.is_err() {
        let _ = b.remove_file(part.as_str()).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    const KNOWN_HOSTS: &str = "/tmp/protunel-kh-test";

    #[test]
    fn only_failed_probes_expire_after_sixty_seconds() {
        let checked_at = Instant::now();
        assert!(probe_is_fresh(
            checked_at + Duration::from_secs(59),
            false,
            checked_at
        ));
        assert!(!probe_is_fresh(
            checked_at + Duration::from_secs(60),
            false,
            checked_at
        ));
        assert!(probe_is_fresh(
            checked_at + Duration::from_secs(3600),
            true,
            checked_at
        ));
    }

    fn destination() -> Tunnel {
        Tunnel {
            id: Uuid::nil(),
            name: "destination".to_string(),
            host: "2001:db8::2".to_string(),
            port: 2222,
            username: "o'neil".to_string(),
            auth: crate::db::AuthMethod::Agent,
            local_socks_port: 0,
            auto_connect: false,
            forwards: Vec::new(),
            jump_tunnel_id: None,
            socks_enabled: false,
            group: None,
            bookmarks: Vec::new(),
        }
    }

    #[test]
    fn parses_rsync_aggregate_progress() {
        assert_eq!(
            parse_progress2("\r  1,024,000  25%   1.00MB/s    0:00:03  "),
            Some((1_024_000, Some(4_096_000)))
        );
        assert_eq!(
            parse_progress2("4,096,000B 100% 8.00MB/s 0:00:01 (xfr#2, to-chk=0/3)"),
            Some((4_096_000, Some(4_096_000)))
        );
        assert_eq!(
            parse_progress2("123 0% 1.20kB/s ??:??:??"),
            Some((123, None))
        );
        assert_eq!(parse_progress2("receiving incremental file list"), None);
        assert_eq!(parse_progress2("123 25%"), None);
        assert_eq!(parse_progress2("123 101% 1.0MB/s 0:00:00"), None);
    }

    #[test]
    fn quotes_probe_and_key_hint() {
        let tunnel = destination();
        assert_eq!(
            probe_command(&tunnel, KNOWN_HOSTS),
            r"'ssh' '-F' '/dev/null' '-o' 'BatchMode=yes' '-o' 'ConnectTimeout=5' '-o' 'UserKnownHostsFile=/tmp/protunel-kh-test' '-o' 'GlobalKnownHostsFile=/dev/null' '-o' 'StrictHostKeyChecking=yes' '-o' 'HostKeyAlias=protunel-dest' '-o' 'VerifyHostKeyDNS=no' '-o' 'ControlPath=none' '-p' '2222' '--' 'o'\''neil@2001:db8::2' 'true'"
        );
        let hint = r"ssh-copy-id -p 2222 'o'\''neil'@'2001:db8::2'";
        assert_eq!(key_hint_command(&tunnel, true).as_deref(), Some(hint));
        assert_eq!(
            key_hint_command(&tunnel, false),
            Some(format!("ssh-keygen -t ed25519 && {hint}"))
        );
    }

    #[test]
    fn omits_key_hint_when_login_has_controls_or_whitespace() {
        for c in [' ', '\n', '\t', '\u{2028}', '\u{a0}', '\u{1b}', '\u{7f}'] {
            let mut tunnel = destination();
            tunnel.username.push(c);
            assert_eq!(key_hint_command(&tunnel, true), None);
            let mut tunnel = destination();
            tunnel.host.push(c);
            assert_eq!(key_hint_command(&tunnel, false), None);
        }
    }

    #[test]
    fn pins_both_copy_transports_and_quotes_host_key_options() {
        let tunnel = destination();
        let options = ssh_options(KNOWN_HOSTS);
        let quoted = shell_command(options.iter().map(String::as_str));
        let scp = scp_command(&tunnel, "file", "/to/.stage", "done", KNOWN_HOSTS);
        assert!(scp.contains(&quoted));
        let rsync = rsync_command(&tunnel, "file", "/to", false, "done", KNOWN_HOSTS);
        let transport = format!("'ssh' {quoted} '-p' '2222'");
        assert!(rsync.contains(&format!("'-e' {}", quote(&transport))));
    }

    #[test]
    fn builds_rsync_commands_with_a_limited_ssh_transport() {
        let tunnel = destination();
        let source = "-a:b 'source'";
        let dest = "/my dir/$(literal)";
        let command = rsync_command(&tunnel, source, dest, false, "done", KNOWN_HOSTS);
        assert!(command.contains("'rsync' '-a' '--no-links' '--out-format=protunel-file:%n' '--ignore-existing' '--info=progress2' '-s'"));
        assert!(command.ends_with(
            r"'--' './-a:b '\''source'\''' 'o'\''neil@[2001:db8::2]:/my dir/$(literal)/'"
        ));
        let overwrite = rsync_command(&tunnel, source, dest, true, "done", KNOWN_HOSTS);
        assert!(overwrite.contains("'--ignore-times'"));
        assert!(!overwrite.contains("--ignore-existing"));
    }

    #[test]
    fn scp_uses_sftp_mode_when_the_remote_path_needs_it() {
        let tunnel = destination();
        let command = scp_command(
            &tunnel,
            "/from/a b",
            "/to/it's a stage",
            "done",
            KNOWN_HOSTS,
        );
        assert!(command.contains("'scp' '-p' '-s'"));
        assert!(!command.contains("'-rp'"));
        assert!(command.contains("'StrictHostKeyChecking=yes'"));
        assert!(command.ends_with(
            r"'-P' '2222' '--' '/from/a b' 'o'\''neil@[2001:db8::2]:/to/it'\''s a stage/'"
        ));
        assert!(
            scp_command(&tunnel, "file", "/to/.stage", "done", KNOWN_HOSTS)
                .contains("'scp' '-p' '-F' '/dev/null' '-o'")
        );
    }
}
