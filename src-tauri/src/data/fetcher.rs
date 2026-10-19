use anyhow::Result;
use serde::Deserialize;
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

pub struct DataFetcher;

impl DataFetcher {
    pub fn new() -> Self {
        Self
    }

    pub async fn fetch(&self, options: &FetchOptions) -> Result<serde_json::Value> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(options.timeout_secs))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()?;

        let method = normalize_method(&options.method);
        let mut request = client.request(method, &options.url);

        if let Some(headers) = &options.headers {
            for (key, value) in headers {
                request = request.header(key, value);
            }
        }

        let response = request.send().await?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP {} from {}",
                response.status(),
                options.url
            ));
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

        Ok(data)
    }
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

        let fetcher = DataFetcher::new();
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

        let fetcher = DataFetcher::new();
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
}
