use anyhow::Result;
use serde::Deserialize;
use std::net::IpAddr;
use std::time::Duration;

#[derive(Debug, Deserialize)]
pub struct FetchOptions {
    pub url: String,
    pub method: String,
    pub headers: Option<Vec<(String, String)>>,
    pub timeout_secs: u64,
    pub max_size_bytes: u64,
    pub json_path: Option<String>,
}

pub struct DataFetcher {
    /// Skip the address checks. Only tests set it: the size-limit tests
    /// fetch from a loopback listener, which the guard refuses.
    allow_private: bool,
}

impl DataFetcher {
    pub fn new() -> Self {
        Self {
            allow_private: false,
        }
    }

    /// Test-only: permits loopback/private listeners. The SSRF tests use
    /// `new()` — the guard is the thing under test there.
    #[cfg(test)]
    fn allowing_private() -> Self {
        Self {
            allow_private: true,
        }
    }

    pub async fn fetch(&self, options: &FetchOptions) -> Result<serde_json::Value> {
        // Redirects are followed by hand so every hop goes through
        // `validate_url`: an automatic policy would happily follow a
        // permitted host's redirect into the LAN (P13).
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(options.timeout_secs))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;

        let mut url = reqwest::Url::parse(&options.url)?;
        let mut method = normalize_method(&options.method);

        // One initial request plus up to five redirects, the same limit the
        // old automatic policy had.
        for _hop in 0..=5 {
            validate_url(&url, self.allow_private).await?;

            let mut request = client.request(method.clone(), url.clone());
            if let Some(headers) = &options.headers {
                for (key, value) in headers {
                    request = request.header(key, value);
                }
            }
            let response = request.send().await?;
            let status = response.status();

            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok());
            if let Some(next) = redirect_target(status, location, &url)? {
                // 301/302/303 drop a body-carrying method; 307/308 keep it
                // (there is no body here either way — `FetchOptions` has
                // none — so only the method matters).
                if matches!(status.as_u16(), 301..=303) {
                    method = reqwest::Method::GET;
                }
                url = next;
                continue;
            }

            if !status.is_success() {
                return Err(anyhow::anyhow!("HTTP {} from {}", status, options.url));
            }

            // `content_length` is a hint from the server and is absent for
            // chunked responses — an attacker can send 100 MB chunked and bypass
            // a header-only check. Read the body and enforce the limit on the
            // actual bytes received.
            let content_length = response.content_length().unwrap_or(0);
            if content_length > options.max_size_bytes {
                return Err(anyhow::anyhow!(
                    "Response too large: {} bytes (max {})",
                    content_length,
                    options.max_size_bytes
                ));
            }

            let bytes = response.bytes().await?;
            if bytes.len() as u64 > options.max_size_bytes {
                return Err(anyhow::anyhow!(
                    "Response too large: {} bytes (max {})",
                    bytes.len(),
                    options.max_size_bytes
                ));
            }

            let text = String::from_utf8_lossy(&bytes);
            let data: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| anyhow::anyhow!("Invalid JSON from {}: {}", options.url, e))?;

            // Apply JSON path if specified
            if let Some(path) = &options.json_path {
                return Ok(extract_json_path(&data, path));
            }

            return Ok(data);
        }

        Err(anyhow::anyhow!(
            "More than 5 redirects fetching {}",
            options.url
        ))
    }
}

/// Check one hop: `http`/`https` only, and every address the host resolves
/// to must be publicly routable. Called for the first URL and again for
/// every redirect — which is what stops a permitted host from redirecting
/// the fetch into the LAN or at the cloud metadata endpoint (P13).
/// `data_url` is untrusted input: a deep link (`printninja://print?url=…`)
/// or a REST caller can set it, so without this a print probes localhost.
///
/// Known limit: reqwest re-resolves the name when it connects, so a DNS
/// answer that changes between this check and the connect (DNS rebinding)
/// is not caught. Pinning the checked IP for the connection would close
/// that; it is outside this plan's scope.
async fn validate_url(url: &reqwest::Url, allow_private: bool) -> Result<()> {
    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(anyhow::anyhow!(
                "Refused scheme '{other}' in data URL (only http and https)"
            ))
        }
    }
    if allow_private {
        return Ok(());
    }

    // `host_str()` brackets IPv6 literals ("[::1]"), which DNS cannot parse.
    // An IP literal also needs no resolution: the address *is* the
    // destination, so the policy check sees exactly what will be connected
    // to. Only real domain names go through DNS.
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("Data URL has no host"))?;
    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);

    if let Ok(ip) = bare.parse::<IpAddr>() {
        if is_forbidden_addr(ip) {
            return Err(anyhow::anyhow!(
                "Refused data URL {url}: '{host}' targets {ip} (loopback, link-local or private)"
            ));
        }
        return Ok(());
    }

    let port = url.port_or_known_default().unwrap_or(80);
    let addrs: Vec<std::net::IpAddr> = tokio::net::lookup_host((bare, port))
        .await?
        .map(|a| a.ip())
        .collect();
    if addrs.is_empty() {
        return Err(anyhow::anyhow!("Data URL host '{host}' does not resolve"));
    }
    for ip in addrs {
        if is_forbidden_addr(ip) {
            return Err(anyhow::anyhow!(
                "Refused data URL {url}: '{host}' resolves to {ip} (loopback, link-local or private)"
            ));
        }
    }
    Ok(())
}

/// Addresses a print's data never legitimately comes from: loopback,
/// link-local (which includes the cloud metadata endpoint 169.254.169.254),
/// RFC1918 private, carrier-grade NAT, unique-local (fc00::/7), unspecified
/// and multicast.
fn is_forbidden_addr(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                // 100.64.0.0/10 carrier-grade NAT (Ipv4Addr::is_shared is
                // still unstable).
                || (u32::from(v4) & 0xffc0_0000) == 0x6440_0000
                || v4.is_unspecified()
                || v4.is_multicast()
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_forbidden_addr(IpAddr::V4(mapped));
            }
            v6.is_loopback()
                || v6.is_unicast_link_local()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (v6.segments()[0] & 0xfe00) == 0xfc00
        }
    }
}

/// The next hop of a redirect, or `None` when the response is final.
/// Relative `Location` values resolve against the URL that sent them.
fn redirect_target(
    status: reqwest::StatusCode,
    location: Option<&str>,
    base: &reqwest::Url,
) -> Result<Option<reqwest::Url>> {
    if !status.is_redirection() {
        return Ok(None);
    }
    let location = location.ok_or_else(|| {
        anyhow::anyhow!("Redirect {status} without a Location header from {base}")
    })?;
    Ok(Some(base.join(location)?))
}

pub(crate) fn normalize_method(raw: &str) -> reqwest::Method {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return reqwest::Method::GET;
    }
    let upper = trimmed.to_ascii_uppercase();
    // `Method::from_bytes` accepts any token (including "NOTAMETHOD") as an
    // extension method, so whitelist the methods we actually support.
    match upper.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        "HEAD" => reqwest::Method::HEAD,
        "OPTIONS" => reqwest::Method::OPTIONS,
        _ => reqwest::Method::GET,
    }
}

fn extract_json_path(data: &serde_json::Value, path: &str) -> serde_json::Value {
    let parts: Vec<&str> = path.split('.').collect();
    let mut current = data;

    for part in parts {
        if let Some(index) = part.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            if let Ok(i) = index.parse::<usize>() {
                current = &current[i];
            }
        } else {
            current = &current[part];
        }
    }

    current.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Accepts one connection, reads the request, sends `resp`, then closes
    /// cleanly. The server must read the request before closing: on Windows,
    /// closing a socket with unread data sends a RST, which discards the
    /// response before the client reads it (os error 10053).
    async fn serve_once(resp: String) -> std::net::SocketAddr {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut req = Vec::new();
            let mut buf = [0u8; 1024];
            while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                match socket.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => req.extend_from_slice(&buf[..n]),
                }
            }
            let _ = socket.write_all(resp.as_bytes()).await;
            let _ = socket.flush().await;
            let _ = socket.shutdown().await;
            // Wait for the client to close its side before dropping the socket.
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), async {
                while let Ok(n) = socket.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                }
            })
            .await;
        });
        addr
    }

    #[test]
    fn method_validation_trims_and_uppercases() {
        assert_eq!(normalize_method("get"), reqwest::Method::GET);
        assert_eq!(normalize_method("  POST  "), reqwest::Method::POST);
        assert_eq!(normalize_method("put"), reqwest::Method::PUT);
    }

    #[test]
    fn method_validation_defaults_to_get_for_garbage() {
        // These used to bubble as `Method::from_bytes` errors and surface as
        // 500s to the caller.
        assert_eq!(normalize_method(""), reqwest::Method::GET);
        assert_eq!(normalize_method("   "), reqwest::Method::GET);
        assert_eq!(normalize_method("GET "), reqwest::Method::GET);
        assert_eq!(normalize_method("NOTAMETHOD"), reqwest::Method::GET);
        assert_eq!(normalize_method("get\n"), reqwest::Method::GET);
    }

    #[test]
    fn extract_json_path_traverses_nested_objects() {
        let data = serde_json::json!({"a": {"b": {"c": 42}}});
        assert_eq!(extract_json_path(&data, "a.b.c"), serde_json::json!(42));
    }

    #[test]
    fn extract_json_path_supports_array_index() {
        let data = serde_json::json!({"items": [10, 20, 30]});
        assert_eq!(extract_json_path(&data, "items.[1]"), serde_json::json!(20));
    }

    #[test]
    fn extract_json_path_returns_null_for_missing_key() {
        let data = serde_json::json!({"a": 1});
        assert_eq!(extract_json_path(&data, "missing"), serde_json::Value::Null);
        assert_eq!(
            extract_json_path(&data, "a.missing.deep"),
            serde_json::Value::Null
        );
    }

    #[tokio::test]
    async fn size_limit_is_enforced_on_chunked_bodies() {
        // Spin up a tiny server that streams without Content-Length.
        // Chunked: no Content-Length, body is 200 bytes of JSON.
        let body = "a".repeat(200);
        let json = format!("\"{}\"", body);
        let resp = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
            json.len(),
            json
        );
        let addr = serve_once(resp).await;

        let fetcher = DataFetcher::allowing_private();
        let opts = FetchOptions {
            url: format!("http://{}/data", addr),
            method: "GET".into(),
            headers: None,
            timeout_secs: 5,
            max_size_bytes: 10, // smaller than the 200-byte body
            json_path: None,
        };
        let err = fetcher.fetch(&opts).await.unwrap_err().to_string();
        assert!(err.contains("too large"), "{err}");
        assert!(err.contains("10"), "{err}");
    }

    #[tokio::test]
    async fn size_limit_allows_small_bodies() {
        let json = r#"{"ok": true}"#;
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\n\r\n{}",
            json.len(),
            json
        );
        let addr = serve_once(resp).await;

        let fetcher = DataFetcher::allowing_private();
        let opts = FetchOptions {
            url: format!("http://{}/data", addr),
            method: "GET".into(),
            headers: None,
            timeout_secs: 5,
            max_size_bytes: 1024,
            json_path: None,
        };
        let val = fetcher.fetch(&opts).await.unwrap();
        assert_eq!(val["ok"], true);
    }

    // ───────────────────────────────────────────────────────────────
    // P13: data_url is untrusted input and cannot reach non-public hosts
    // ───────────────────────────────────────────────────────────────

    #[test]
    fn loopback_private_and_link_local_addresses_are_forbidden() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        for addr in [
            "127.0.0.1",
            "127.8.9.10",
            "::1",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254", // cloud metadata lives here
            "fe80::1",
            "fd00::1",
            "fc00::1",
            "100.64.0.1", // carrier-grade NAT
            "0.0.0.0",
            "::",
            "::ffff:127.0.0.1", // IPv4-mapped loopback
        ] {
            assert!(is_forbidden_addr(ip(addr)), "{addr} must be refused");
        }
        for addr in [
            "8.8.8.8",
            "1.1.1.1",
            "93.184.216.34",
            "2606:4700:4700::1111",
        ] {
            assert!(!is_forbidden_addr(ip(addr)), "{addr} must be allowed");
        }
    }

    #[tokio::test]
    async fn only_http_and_https_schemes_are_fetched() {
        for url in [
            "file:///etc/passwd",
            "ftp://example.com/x",
            "gopher://example.com/7",
        ] {
            let err = validate_url(&reqwest::Url::parse(url).unwrap(), false)
                .await
                .unwrap_err()
                .to_string();
            assert!(err.contains("scheme"), "{url} -> {err}");
        }
    }

    #[tokio::test]
    async fn loopback_and_metadata_urls_are_refused() {
        for url in [
            "http://127.0.0.1:8080/x",
            "http://localhost:8080/x", // resolves to loopback
            "http://[::1]/x",
            "http://169.254.169.254/latest/meta-data/",
            "http://10.1.2.3/x",
            "http://192.168.1.10/x",
            "https://[fd00::1]/x",
        ] {
            let err = validate_url(&reqwest::Url::parse(url).unwrap(), false)
                .await
                .unwrap_err()
                .to_string();
            assert!(err.contains("Refused"), "{url} -> {err}");
        }
    }

    /// The guard runs before any connection: the fetch fails with the
    /// reason even when the refusal is the whole outcome.
    #[tokio::test]
    async fn fetch_refuses_a_loopback_data_url() {
        let fetcher = DataFetcher::new();
        let opts = FetchOptions {
            url: "http://127.0.0.1:9/x".into(),
            method: "GET".into(),
            headers: None,
            timeout_secs: 5,
            max_size_bytes: 1024,
            json_path: None,
        };
        let err = fetcher.fetch(&opts).await.unwrap_err().to_string();
        assert!(err.contains("Refused"), "{err}");
    }

    #[test]
    fn redirect_targets_are_resolved_against_the_base_url() {
        let base = reqwest::Url::parse("http://example.com/a/b").unwrap();
        let found = reqwest::StatusCode::FOUND;

        let abs = redirect_target(found, Some("/next"), &base)
            .unwrap()
            .unwrap();
        assert_eq!(abs.as_str(), "http://example.com/next");

        let rel = redirect_target(found, Some("next"), &base)
            .unwrap()
            .unwrap();
        assert_eq!(rel.as_str(), "http://example.com/a/next");

        // Every hop — wherever it points — goes through validate_url.
        let cross = redirect_target(found, Some("http://other.example/z"), &base)
            .unwrap()
            .unwrap();
        assert_eq!(cross.host_str(), Some("other.example"));

        assert!(
            redirect_target(reqwest::StatusCode::OK, None, &base)
                .unwrap()
                .is_none(),
            "a final response is not a hop"
        );
        assert!(
            redirect_target(found, None, &base).is_err(),
            "a redirect without a Location header is an error"
        );
    }
}
