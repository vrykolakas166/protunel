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

/// Builds the PAC script. Everything not bypassed goes to the router, with no
/// `DIRECT` fallback: if the router is down the request fails instead of
/// silently escaping the rules it was supposed to obey.
pub fn build_script(socks_port: u16, bypass_list: &str) -> String {
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

    format!(
        "function FindProxyForURL(url, host) {{\n{bypass}  return \"SOCKS5 127.0.0.1:{socks_port}\";\n}}\n"
    )
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

    let response = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: application/x-ns-proxy-autoconfig\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n{script}",
        script.len()
    );

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
        let script = build_script(1090, "<local>");
        assert!(script.contains("return \"SOCKS5 127.0.0.1:1090\";"));
        // The final return must be the proxy, not a DIRECT escape hatch.
        assert!(!script.contains("SOCKS5 127.0.0.1:1090; DIRECT"));
    }

    #[test]
    fn loopback_and_plain_hostnames_bypass() {
        let script = build_script(1090, "");
        assert!(script.contains("isPlainHostName(host)"));
        assert!(script.contains("127.*"));
    }

    #[test]
    fn bypass_entries_become_patterns_and_local_is_not_duplicated() {
        let script = build_script(1090, "<local>;*.corp.net;10.*");
        assert!(script.contains("shExpMatch(host, \"*.corp.net\")"));
        assert!(script.contains("shExpMatch(host, \"10.*\")"));
        assert!(!script.contains("<local>"));
    }

    #[test]
    fn entries_that_could_break_out_of_the_js_string_are_dropped() {
        let script = build_script(1090, "evil\") || (1; ok.net");
        assert!(!script.contains("evil"));
        assert!(script.contains("shExpMatch(host, \"ok.net\")"));
    }
}
