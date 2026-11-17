//! Serves a proxy auto-config script over loopback HTTP.
//!
//! Windows' fixed-proxy setting (`ProxyServer = socks=host:port`) speaks
//! **SOCKS4**, which a SOCKS5 listener has to refuse — so pointing the system
//! proxy straight at the router does not work. A PAC script can name `SOCKS5`
//! explicitly, so that is what `AutoConfigURL` gets pointed at instead.
//!
//! The script deliberately does **not** reimplement the rule engine: it sends
//! everything to the router and lets the Rust matcher decide. The only thing it
//! handles itself is the bypass list, because those hosts must never reach the
//! router in the first place.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

/// Builds the PAC script. Everything not bypassed goes to the router.
///
/// Without `fallback_direct` there is no `DIRECT` escape: if the router is down
/// the request fails instead of silently escaping the rules it was supposed to
/// obey. That is the Windows system-proxy script, which protunel removes again
/// on exit.
///
/// With `fallback_direct` the script ends `SOCKS5 ...; DIRECT`. That is the
/// copy served on the router port for hand-configured browsers: protunel cannot
/// unconfigure those on exit, and a browser that fails to re-fetch its PAC keeps
/// running the last one it loaded (Firefox does). Without the fallback, closing
/// protunel would cut such a browser off the network entirely.
pub fn build_script(socks_port: u16, bypass_list: &str, fallback_direct: bool) -> String {
    let mut bypass = String::new();

    // Loopback and single-label names must resolve locally — routing them
    // through the proxy (which lives on loopback itself) would loop.
    bypass.push_str(
        "  if (isPlainHostName(host) || host === \"localhost\" || host === \"::1\") return \"DIRECT\";\n\
         \x20 if (shExpMatch(host, \"127.*\")) return \"DIRECT\";\n",
    );

    for entry in bypass_list.split(';') {
        let entry = entry.trim();
        // `<local>` is Windows shorthand already covered by isPlainHostName.
        if entry.is_empty() || entry.eq_ignore_ascii_case("<local>") {
            continue;
        }
        // A quote or backslash would break out of the JS string literal.
        if entry.contains('"') || entry.contains('\\') {
            continue;
        }
        bypass.push_str(&format!(
            "  if (shExpMatch(host, \"{entry}\")) return \"DIRECT\";\n"
        ));
    }

    let fallback = if fallback_direct { "; DIRECT" } else { "" };
    format!(
        "function FindProxyForURL(url, host) {{\n{bypass}  return \"SOCKS5 127.0.0.1:{socks_port}{fallback}\";\n}}\n"
    )
}

/// Path the script is served at, both on the Windows PAC port and on the
/// router's own SOCKS port.
pub const PAC_PATH: &str = "/protunel.pac";

/// The complete HTTP response carrying `script`. `no-store` so a browser
/// re-fetches it instead of pinning an old port or bypass list.
pub fn http_response(script: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: application/x-ns-proxy-autoconfig\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n{script}",
        script.len()
    )
}

/// Whether `head` (the first bytes a client sent) is a request for the PAC
/// script. Strict on purpose: the router port also gets mistaken for an HTTP
/// proxy (`http_proxy=127.0.0.1:1090`), and those absolute-form
/// `GET http://...` requests must keep being refused, not answered with a PAC.
pub fn is_pac_request(head: &[u8]) -> bool {
    let Some(rest) = head.strip_prefix(b"GET ") else {
        return false;
    };
    let Some(rest) = rest.strip_prefix(PAC_PATH.as_bytes()) else {
        return false;
    };
    matches!(rest.first(), Some(b' ') | Some(b'?'))
}

/// Binds an ephemeral loopback port and serves `script` to anything that
/// connects. Returns the port actually bound. Stops when `cancel` fires.
pub async fn spawn(script: String, cancel: CancellationToken) -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("failed to bind PAC port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("failed to read PAC port: {e}"))?
        .port();

    let response = http_response(&script);

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                accepted = listener.accept() => {
                    let Ok((mut stream, _)) = accepted else { break };
                    let response = response.clone();
                    tokio::spawn(async move {
                        // Drain the request line/headers before replying; some
                        // clients treat a response-then-RST as a failed fetch.
                        let mut buf = [0u8; 1024];
                        let _ = tokio::time::timeout(
                            Duration::from_secs(2),
                            stream.read(&mut buf),
                        )
                        .await;
                        let _ = stream.write_all(response.as_bytes()).await;
                        let _ = stream.shutdown().await;
                    });
                }
            }
        }
    });

    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_routes_everything_to_the_router_with_no_direct_fallback() {
        let script = build_script(1090, "<local>", false);
        assert!(script.contains("return \"SOCKS5 127.0.0.1:1090\";"));
        // The final return must be the proxy, not a DIRECT escape hatch.
        assert!(!script.contains("DIRECT\";\n}"));
    }

    #[test]
    fn browser_script_falls_back_to_direct_when_the_router_is_gone() {
        let script = build_script(1090, "<local>", true);
        assert!(script.contains("return \"SOCKS5 127.0.0.1:1090; DIRECT\";"));
        // Bypass handling is the same in both variants.
        assert!(script.contains("isPlainHostName(host)"));
    }

    #[test]
    fn recognises_only_a_get_for_the_pac_path() {
        assert!(is_pac_request(b"GET /protunel.pac HTTP/1.1\r\nHost: x\r\n\r\n"));
        assert!(is_pac_request(b"GET /protunel.pac?t=1 HTTP/1.1\r\n"));
        // SOCKS5 greeting.
        assert!(!is_pac_request(&[0x05, 0x01, 0x00]));
        // The port mistaken for an HTTP proxy.
        assert!(!is_pac_request(b"GET http://example.com/ HTTP/1.1\r\n"));
        assert!(!is_pac_request(b"CONNECT example.com:443 HTTP/1.1\r\n"));
        assert!(!is_pac_request(b"GET /protunel.pacx HTTP/1.1\r\n"));
        assert!(!is_pac_request(b"GET / HTTP/1.1\r\n"));
        assert!(!is_pac_request(b"POST /protunel.pac HTTP/1.1\r\n"));
        assert!(!is_pac_request(b""));
    }

    #[test]
    fn response_carries_the_script_with_its_length() {
        let script = build_script(1090, "", false);
        let response = http_response(&script);
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.contains(&format!("Content-Length: {}\r\n", script.len())));
        assert!(response.ends_with(&script));
    }

    #[test]
    fn loopback_and_plain_hostnames_bypass() {
        let script = build_script(1090, "", false);
        assert!(script.contains("isPlainHostName(host)"));
        assert!(script.contains("127.*"));
    }

    #[test]
    fn bypass_entries_become_patterns_and_local_is_not_duplicated() {
        let script = build_script(1090, "<local>;*.corp.net;10.*", false);
        assert!(script.contains("shExpMatch(host, \"*.corp.net\")"));
        assert!(script.contains("shExpMatch(host, \"10.*\")"));
        assert!(!script.contains("<local>"));
    }

    #[test]
    fn entries_that_could_break_out_of_the_js_string_are_dropped() {
        let script = build_script(1090, "evil\") || (1; ok.net", false);
        assert!(!script.contains("evil"));
        assert!(script.contains("shExpMatch(host, \"ok.net\")"));
    }
}
