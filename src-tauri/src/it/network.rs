use super::*;
use crate::commands::{confirm_host_key, reject_host_key};
use crate::db::PortForward;
use crate::events::{TunnelStatus, HOST_KEY_PENDING_EVENT, STATUS_EVENT};
use crate::router::{
    self,
    rules::{RouterRule, RuleAction, RuleKind},
};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn socks_request(port: u16, host: &str, target_port: u16) -> TcpStream {
    let mut stream = loopback(port).await;
    stream.write_all(&[5, 1, 0]).await.unwrap();
    let mut greeting = [0; 2];
    stream.read_exact(&mut greeting).await.unwrap();
    assert_eq!(greeting, [5, 0]);

    // Send a domain address on the wire so Docker DNS runs on the SSH side.
    let mut request = vec![5, 1, 0, 3, u8::try_from(host.len()).unwrap()];
    request.extend_from_slice(host.as_bytes());
    request.extend_from_slice(&target_port.to_be_bytes());
    stream.write_all(&request).await.unwrap();
    stream
}

async fn socks_reply(stream: &mut TcpStream) -> u8 {
    let mut header = [0; 4];
    stream.read_exact(&mut header).await.unwrap();
    assert_eq!((header[0], header[2]), (5, 0));
    let address_len = match header[3] {
        1 => 4,
        3 => usize::from(stream.read_u8().await.unwrap()),
        4 => 16,
        other => panic!("unexpected SOCKS5 address type {other}"),
    };
    stream
        .read_exact(&mut vec![0; address_len + 2])
        .await
        .unwrap();
    header[1]
}

async fn http(mut stream: TcpStream) {
    stream
        .write_all(b"GET /fixture.txt HTTP/1.0\r\nHost: srv-a\r\n\r\n")
        .await
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    assert!(response.starts_with("HTTP/1.0 200 "), "{response}");
    assert_eq!(response.split_once("\r\n\r\n").unwrap().1, HTTP_BODY);
}

async fn socks_http(port: u16) {
    bounded("SOCKS5 HTTP request", async {
        let mut stream = socks_request(port, "srv-a", 8080).await;
        assert_eq!(socks_reply(&mut stream).await, 0);
        http(stream).await;
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_tunnel_password_connect() {
    run(async |case| {
        let tunnel = case.tunnel("127.0.0.1", 2201);
        case.save(&tunnel);
        case.trust(&tunnel, "srv-a").await;
        case.connect(&tunnel).await;
        assert_eq!(case.exec(&tunnel, "id -un").await.trim(), "alice");
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_tunnel_key_connect() {
    run(async |case| {
        let mut tunnel = case.tunnel("127.0.0.1", 2202);
        bob(&mut tunnel);
        case.save(&tunnel);
        case.trust(&tunnel, "srv-b").await;
        case.connect(&tunnel).await;
        assert_eq!(case.exec(&tunnel, "id -un").await.trim(), "bob");
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_tunnel_socks_hostname() {
    run(async |case| {
        let mut tunnel = case.tunnel("127.0.0.1", 2201);
        tunnel.socks_enabled = true;
        tunnel.local_socks_port = local_port();
        case.save(&tunnel);
        case.trust(&tunnel, "srv-a").await;
        case.connect(&tunnel).await;
        socks_http(tunnel.local_socks_port).await;
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_tunnel_local_forward() {
    run(async |case| {
        let mut tunnel = case.tunnel("127.0.0.1", 2201);
        let port = local_port();
        tunnel.forwards.push(PortForward {
            id: Uuid::new_v4(),
            tunnel_id: tunnel.id,
            remote_host: "127.0.0.1".into(),
            remote_port: 8080,
            local_port: port,
        });
        case.save(&tunnel);
        case.trust(&tunnel, "srv-a").await;
        case.connect(&tunnel).await;
        bounded("forwarded HTTP request", async {
            http(loopback(port).await).await
        })
        .await;
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_tunnel_reconnect_keeps_port() {
    run(async |case| {
        let mut tunnel = case.tunnel("127.0.0.1", 2201);
        tunnel.socks_enabled = true;
        tunnel.local_socks_port = local_port();
        case.save(&tunnel);
        case.trust(&tunnel, "srv-a").await;
        case.connect(&tunnel).await;
        socks_http(tunnel.local_socks_port).await;
        let first = case.state().session_for(tunnel.id).unwrap();
        let mut statuses = Events::listen(case.app, STATUS_EVENT, tunnel.id);

        let container = docker(&["ps", "-q", "srv-a"]).await;
        assert!(!container.trim().is_empty());
        let mut restart = std::process::Command::new("docker");
        restart.args(["restart", "--time", "1", container.trim()]);
        let output = tokio::process::Command::from(restart)
            .kill_on_drop(true)
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(statuses.next().await["status"], "reconnecting");
        assert!(std::net::TcpListener::bind(("127.0.0.1", tunnel.local_socks_port)).is_err());

        timeout(Duration::from_secs(25), async {
            loop {
                if case
                    .state()
                    .session_for(tunnel.id)
                    .is_some_and(|current| !Arc::ptr_eq(&first, &current))
                {
                    break;
                }
                sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("a new SSH session after restart");
        socks_http(tunnel.local_socks_port).await;
    })
    .await;
}

async fn terminal_error(case: &Case, tunnel: &Tunnel) -> String {
    until("failed supervisor to exit", async || {
        (!case.state().is_connected(tunnel.id)).then_some(())
    })
    .await;
    assert!(case.state().session_for(tunnel.id).is_none());
    let status = case
        .state()
        .statuses()
        .into_iter()
        .find(|item| item.tunnel_id == tunnel.id)
        .unwrap();
    assert_eq!(status.status, TunnelStatus::Error);
    status.message.unwrap()
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_tunnel_bad_password_is_fatal() {
    run(async |case| {
        let tunnel = case.tunnel("127.0.0.1", 2201);
        case.save(&tunnel);
        TEST_SECRETS
            .lock()
            .unwrap()
            .insert(tunnel.id, Some("wrong-password".into()));
        case.trust(&tunnel, "srv-a").await;
        assert!(case.state().settings.get().auto_reconnect_enabled);
        let mut statuses = Events::listen(case.app, STATUS_EVENT, tunnel.id);
        case.start(&tunnel).await;
        assert!(terminal_error(case, &tunnel)
            .await
            .contains("authentication failed"));
        assert_eq!(statuses.next().await["status"], "connecting");
        assert_eq!(statuses.next().await["status"], "error");
        assert!(statuses.rx.try_recv().is_err());
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_tunnel_duplicate_connect_race() {
    run(async |case| {
        let tunnel = case.tunnel("127.0.0.1", 2201);
        case.save(&tunnel);
        case.trust(&tunnel, "srv-a").await;
        let mut statuses = Events::listen(case.app, STATUS_EVENT, tunnel.id);
        let start = Arc::new(tokio::sync::Barrier::new(2));
        let workers = [0, 1].map(|_| {
            let (app, id, start) = (case.app, tunnel.id, start.clone());
            tokio::spawn(async move {
                start.wait().await;
                connect_one(app, &app.state::<AppState>(), id)
                    .await
                    .unwrap();
            })
        });
        for worker in workers {
            worker.await.unwrap();
        }
        wait_for_session(case.state(), tunnel.id, SHORT)
            .await
            .unwrap();
        assert_eq!(case.state().running_ids(), [tunnel.id]);
        // The map has one slot per ID even if two supervisors are spawned.
        // Each actual supervisor emits Connecting once on entry.
        assert_eq!(statuses.next().await["status"], "connecting");
        assert_eq!(statuses.next().await["status"], "connected");
        assert!(timeout(Duration::from_millis(250), statuses.rx.recv())
            .await
            .is_err());
        assert_eq!(case.exec(&tunnel, "id -un").await.trim(), "alice");
    })
    .await;
}

async fn pending_prompt(case: &Case, tunnel: &Tunnel) -> (Uuid, String) {
    let mut prompts = Events::listen(case.app, HOST_KEY_PENDING_EVENT, tunnel.id);
    case.start(tunnel).await;
    let prompt = prompts.next().await;
    assert_eq!(prompt["host"], tunnel.host);
    assert_eq!(prompt["port"], tunnel.port);
    assert_eq!(prompt["algorithm"], "ssh-ed25519");
    assert!(case.state().session_for(tunnel.id).is_none());
    assert!(case
        .state()
        .known_hosts
        .openssh_key(&key_id(tunnel))
        .is_none());
    (
        serde_json::from_value(prompt["requestId"].clone()).unwrap(),
        prompt["fingerprint"].as_str().unwrap().into(),
    )
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_tunnel_host_key_confirm() {
    run(async |case| {
        let tunnel = case.tunnel("127.0.0.1", 2201);
        case.save(&tunnel);
        let (request, fingerprint) = pending_prompt(case, &tunnel).await;
        confirm_host_key(case.app.clone(), case.app.state(), request).unwrap();
        wait_for_session(case.state(), tunnel.id, SHORT)
            .await
            .unwrap();
        let trusted = case.state().known_hosts.list();
        assert!(trusted
            .iter()
            .any(|(id, key)| id == &key_id(&tunnel) && key.fingerprint == fingerprint));
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_tunnel_host_key_reject() {
    run(async |case| {
        let tunnel = case.tunnel("127.0.0.1", 2201);
        case.save(&tunnel);
        let (request, _) = pending_prompt(case, &tunnel).await;
        reject_host_key(case.app.clone(), case.app.state(), request).unwrap();
        terminal_error(case, &tunnel).await;
        assert!(case
            .state()
            .known_hosts
            .openssh_key(&key_id(&tunnel))
            .is_none());
        assert!(case.state().known_hosts.mismatches().is_empty());
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_tunnel_host_key_changed() {
    run(async |case| {
        let tunnel = case.tunnel("127.0.0.1", 2201);
        case.save(&tunnel);
        case.trust(&tunnel, "srv-b").await;
        let key_id = key_id(&tunnel);
        let old_key = case.state().known_hosts.openssh_key(&key_id).unwrap();
        let mut prompts = Events::listen(case.app, HOST_KEY_PENDING_EVENT, tunnel.id);
        case.start(&tunnel).await;
        terminal_error(case, &tunnel).await;
        let mismatch = case
            .state()
            .known_hosts
            .mismatches()
            .into_iter()
            .find(|item| item.key_id == key_id)
            .unwrap();
        assert_ne!(mismatch.known_fingerprint, mismatch.offered_fingerprint);
        assert_eq!(
            case.state().known_hosts.openssh_key(&key_id).unwrap(),
            old_key
        );
        assert!(prompts.rx.try_recv().is_err());
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_jump_inner_via_a() {
    run(async |case| {
        let a = case.tunnel("127.0.0.1", 2201);
        let mut inner = case.tunnel("srv-inner", 22);
        inner.jump_tunnel_id = Some(a.id);
        case.save(&a);
        case.save(&inner);
        case.trust(&a, "srv-a").await;
        case.trust(&inner, "srv-inner").await;
        case.connect(&inner).await;
        assert!(case.state().session_for(a.id).is_some());
        assert_eq!(
            case.exec(&inner, "id -un && hostname").await.trim(),
            "alice\nsrv-inner"
        );
    })
    .await;
}

async fn start_router(case: &Case, routes: &[(&str, Uuid)]) -> u16 {
    let state = case.state();
    let rules: Vec<_> = routes
        .iter()
        .enumerate()
        .map(|(position, &(host, tunnel))| RouterRule {
            id: Uuid::new_v4(),
            position: position as i64,
            enabled: true,
            kind: RuleKind::HostWildcard,
            pattern: host.into(),
            port: Some(8080),
            action: RuleAction::Tunnel,
            target_tunnel_id: Some(tunnel),
        })
        .collect();
    state.db.replace_router_rules(&rules).unwrap();
    let mut config = state.router.config();
    config.enabled = true;
    config.port = local_port();
    config.set_system_proxy = false;
    config.default_action = RuleAction::Block;
    let port = config.port;
    state.router.store.update(config).unwrap();
    router::start(case.app).await.unwrap();
    port
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_router_hostname_rule_selects_tunnel() {
    run(async |case| {
        let good = case.tunnel("127.0.0.1", 2201);
        let other = case.tunnel("127.0.0.1", 2202);
        case.save(&good);
        case.save(&other);
        case.trust(&good, "srv-a").await;
        let port = start_router(case, &[("other.invalid", other.id), ("srv-a", good.id)]).await;
        socks_http(port).await;
        let decision = until("router decision", async || {
            case.state()
                .router
                .decisions()
                .into_iter()
                .find(|item| item.host == "srv-a" && item.target_tunnel_id == Some(good.id))
        })
        .await;
        assert_eq!(decision.action, RuleAction::Tunnel);
        assert_eq!(decision.outcome, "ok");
        assert_eq!(case.state().running_ids(), [good.id]);
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_router_stalled_dial_does_not_block_healthy_tunnel() {
    run(async |case| {
        let hang = case.tunnel("127.0.0.1", 2209);
        let good = case.tunnel("127.0.0.1", 2201);
        case.save(&hang);
        case.save(&good);
        case.trust(&good, "srv-a").await;
        let stalled = format!("{}.invalid", hang.id.simple());
        let port = start_router(case, &[(&stalled, hang.id), ("srv-a", good.id)]).await;
        let mut slow = bounded("stalled SOCKS5 request", socks_request(port, &stalled, 8080)).await;
        until("stalled tunnel supervisor", async || {
            case.state().is_connected(hang.id).then_some(())
        }).await;

        // Poll both so the test also fails if the slow reply arrives before HTTP.
        tokio::select! {
            _ = socks_http(port) => {}
            reply = socks_reply(&mut slow) => panic!("stalled SOCKS5 request returned {reply} before healthy HTTP"),
        }
        assert!(case.state().session_for(good.id).is_some());
        assert!(case.state().session_for(hang.id).is_none());
        let reply = timeout(Duration::from_secs(23), socks_reply(&mut slow)).await.expect("stalled request should time out");
        assert_eq!(reply, 4, "SOCKS5 host unreachable");
    }).await;
}
