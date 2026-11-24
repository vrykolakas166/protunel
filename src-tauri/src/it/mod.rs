//! Real OpenSSH integration tests. See docker/it/README.md for the fixtures.

mod copy;
mod network;
mod sftp;

use std::future::Future;
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::sync::{mpsc, OnceLock};
use std::time::Duration;

use russh::keys::ssh_key::{HashAlg, PublicKey};
use tauri::{AppHandle, Listener, Manager};
use tokio::net::TcpStream;
use tokio::time::{sleep, timeout};
use uuid::Uuid;

use crate::commands::{connect_one, wait_for_session};
#[cfg(target_os = "linux")]
use crate::db::Db;
use crate::db::{AuthMethod, Tunnel};
use crate::secrets::TEST_SECRETS;
#[cfg(target_os = "linux")]
use crate::ssh::sftp::Files;
use crate::ssh::sftp::{self as files, Transfer, TransferState};
use crate::AppState;

const ALICE_PASSWORD: &str = "alice-pass";
const HTTP_BODY: &str = "protunel ssh-it\n";
const SHORT: Duration = Duration::from_secs(8);
#[cfg(target_os = "linux")]
const TEST_LIMIT: Duration = Duration::from_secs(55);
const REPO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

#[cfg(target_os = "linux")]
fn app() -> &'static AppHandle {
    static APP: OnceLock<Option<AppHandle>> = OnceLock::new();
    APP.get_or_init(|| {
        // Menu operations dispatch to the Wry thread even with no tray installed.
        let (ready, receive) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let data = std::env::temp_dir().join(format!("protunel-it-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&data).unwrap();
            let state = AppState::new(&data, Db::open(Path::new(":memory:")).unwrap());
            state.settings.modify(|settings| settings.notifications_enabled = false).unwrap();

            let app = tauri::Builder::default()
                .any_thread()
                .manage(state)
                .manage(crate::updates::Updates::default())
                .manage(Files::default())
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .expect("build the Wry test app (use xvfb-run on Linux)");
            // The handle is usable as soon as the app is built; the event
            // loop below only has to keep running for menu/tray calls.
            // (RunEvent::Ready never arrives with the mock context.)
            ready.send(app.handle().clone()).unwrap();
            app.run_return(|_, event| {
                if let tauri::RunEvent::ExitRequested { api, .. } = event {
                    api.prevent_exit();
                }
            });
        });
        // GTK can be initialised only once per process: a failed start must
        // fail every test the same way instead of retrying on a new thread.
        receive.recv_timeout(Duration::from_secs(30)).ok()
    })
    .as_ref()
    .expect("Wry test app did not start")
}

#[cfg(target_os = "linux")]
async fn run(test: impl AsyncFnOnce(&mut Case)) {
    if std::env::var("PROTUNEL_IT").as_deref() != Ok("1") {
        return;
    }
    // One app and one Compose stack per process, even for hand-run tests.
    static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _serial = SERIAL.lock().await;
    let mut case = Case {
        app: app(),
        tunnels: Vec::new(),
        local: None,
    };
    timeout(TEST_LIMIT, test(&mut case))
        .await
        .expect("integration test timed out");
    for tunnel in &case.tunnels {
        case.state().stop_and_wait(tunnel.id).await;
        files::forget(case.app, tunnel.id).await;
    }
    crate::router::stop(case.app).await;
}

// Keep the ignored tests visible and type-check their closures on Windows
// without linking the Wry event-loop paths into the unit-test executable.
#[cfg(not(target_os = "linux"))]
async fn run(_test: impl AsyncFnOnce(&mut Case)) {
    assert_ne!(
        std::env::var("PROTUNEL_IT").as_deref(),
        Ok("1"),
        "ssh-it requires Linux"
    );
}

struct Case {
    app: &'static AppHandle,
    tunnels: Vec<Tunnel>,
    local: Option<PathBuf>,
}

impl Case {
    fn state(&self) -> &AppState {
        self.app.state::<AppState>().inner()
    }

    fn local_dir(&mut self) -> &Path {
        self.local.get_or_insert_with(|| {
            let path = std::env::temp_dir().join(format!("protunel-it-files-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            path
        })
    }

    fn tunnel(&self, host: &str, port: u16) -> Tunnel {
        let id = Uuid::new_v4();
        Tunnel {
            id,
            name: id.to_string(),
            host: host.into(),
            port,
            username: "alice".into(),
            auth: AuthMethod::Password,
            local_socks_port: 0,
            socks_enabled: false,
            auto_connect: false,
            forwards: vec![],
            jump_tunnel_id: None,
            group: None,
            bookmarks: vec![],
        }
    }

    fn save(&mut self, tunnel: &Tunnel) {
        let password = (tunnel.auth == AuthMethod::Password).then(|| ALICE_PASSWORD.into());
        TEST_SECRETS.lock().unwrap().insert(tunnel.id, password);
        self.state().known_hosts.forget(&key_id(tunnel));
        self.state().db.insert(tunnel).unwrap();
        for forward in &tunnel.forwards {
            self.state().db.insert_forward(forward).unwrap();
        }
        self.tunnels.push(tunnel.clone());
    }

    async fn start(&self, tunnel: &Tunnel) {
        connect_one(self.app, self.state(), tunnel.id)
            .await
            .unwrap();
    }

    async fn connect(&self, tunnel: &Tunnel) {
        self.start(tunnel).await;
        wait_for_session(self.state(), tunnel.id, SHORT)
            .await
            .unwrap_or_else(|error| {
                panic!(
                    "{error} ({}; status {:?})",
                    key_id(tunnel),
                    self.state().status(tunnel.id)
                );
            });
    }

    async fn trust(&self, tunnel: &Tunnel, service: &str) {
        let key = docker(&[
            "exec",
            "-T",
            service,
            "cat",
            "/etc/ssh/ssh_host_ed25519_key.pub",
        ])
        .await;
        let key = PublicKey::from_openssh(key.trim()).unwrap();
        // The SSH wire encoding carries no comment from the .pub file.
        let key = PublicKey::new(key.key_data().clone(), "");
        self.state().known_hosts.trust(
            &key_id(tunnel),
            &key.to_openssh().unwrap(),
            &key.fingerprint(HashAlg::Sha256).to_string(),
            &key.algorithm().to_string(),
        );
    }

    async fn exec(&self, tunnel: &Tunnel, command: &str) -> String {
        let session = self.state().session_for(tunnel.id).unwrap();
        let result = files::exec(&session, command, SHORT).await.unwrap();
        assert_eq!(
            result.status,
            Some(0),
            "{command}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        String::from_utf8(result.stdout).unwrap()
    }

    async fn finished(&self, id: Uuid, state: TransferState) -> Transfer {
        let transfer = until("transfer completion", async || {
            files::transfers(self.app).into_iter().find(|item| {
                item.id == id
                    && !matches!(item.state, TransferState::Queued | TransferState::Running)
            })
        })
        .await;
        assert_eq!(transfer.state, state, "{:?}", transfer.error);
        transfer
    }
}

impl Drop for Case {
    fn drop(&mut self) {
        for tunnel in &self.tunnels {
            self.state().stop(tunnel.id);
            self.state().forget_status(tunnel.id);
            self.state().known_hosts.forget(&key_id(tunnel));
            self.state().db.delete(tunnel.id).unwrap();
            TEST_SECRETS.lock().unwrap().remove(&tunnel.id);
        }
        files::clear_finished(self.app);
        if let Some(path) = &self.local {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

fn key_id(tunnel: &Tunnel) -> String {
    format!("{}:{}", tunnel.host, tunnel.port)
}

fn bob(tunnel: &mut Tunnel) {
    tunnel.username = "bob".into();
    tunnel.auth = AuthMethod::PrivateKey {
        path: format!("{REPO}/docker/it/generated-keys/id_ed25519"),
    };
}

fn local_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn until<T>(what: &str, mut probe: impl AsyncFnMut() -> Option<T>) -> T {
    timeout(SHORT, async {
        loop {
            if let Some(value) = probe().await {
                return value;
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
}

async fn docker(args: &[&str]) -> String {
    let result = tokio::process::Command::new("docker")
        .args(["compose", "-f", "docker/it/compose.yaml"])
        .args(args)
        .current_dir(REPO)
        .kill_on_drop(true)
        .output()
        .await
        .expect("run Docker Compose");
    assert!(
        result.status.success(),
        "docker compose {args:?}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap()
}

struct Events {
    app: &'static AppHandle,
    id: tauri::EventId,
    rx: tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
}

impl Events {
    fn listen(app: &'static AppHandle, event: &str, tunnel_id: Uuid) -> Self {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let tunnel_id = serde_json::json!(tunnel_id);
        let id = app.listen(event, move |event| {
            let payload: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
            if payload["tunnelId"] == tunnel_id {
                let _ = tx.send(payload);
            }
        });
        Self { app, id, rx }
    }

    async fn next(&mut self) -> serde_json::Value {
        timeout(SHORT, self.rx.recv())
            .await
            .expect("event timed out")
            .unwrap()
    }
}

impl Drop for Events {
    fn drop(&mut self) {
        self.app.unlisten(self.id);
    }
}

async fn bounded<T>(what: &str, operation: impl Future<Output = T>) -> T {
    timeout(SHORT, operation)
        .await
        .unwrap_or_else(|_| panic!("{what} timed out"))
}

async fn loopback(port: u16) -> TcpStream {
    TcpStream::connect(("127.0.0.1", port)).await.unwrap()
}
