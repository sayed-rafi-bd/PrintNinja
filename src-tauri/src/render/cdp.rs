//! One long-lived headless Edge, driven over the DevTools protocol (CDP).
//!
//! `edge.rs` starts a new `msedge.exe` for every render. Even on a reused
//! profile that costs process start-up, a fresh renderer and a fresh print
//! pipeline per label. Here Edge is started **once**, kept running, and each
//! job only opens a tab, loads its HTML, prints or screenshots it and closes
//! the tab. Jobs run in tabs side by side, so concurrent prints no longer
//! need throwaway profiles either.
//!
//! How it works:
//!
//! * Edge is launched with `--remote-debugging-port=0` on its own profile
//!   (`edge-cdp-profile`, never shared with the one-shot launcher). It writes
//!   the port it picked and the browser's WebSocket path to
//!   `DevToolsActivePort` in the profile; that file is how we find it.
//! * One WebSocket carries every request. A reader task routes replies to the
//!   waiting call by `id` and broadcasts events (`Page.loadEventFired`, …).
//! * If anything about the persistent browser goes wrong, callers get an
//!   `Err` and fall back to the one-shot launcher in `edge.rs`, so printing
//!   still works exactly as it did before this module existed. A failed
//!   start is not retried for [`RETRY_AFTER`], so a machine where this cannot
//!   work pays for one failed attempt, not one per print.
//!
//! The debugging port listens on 127.0.0.1 only. Any process on this machine
//! that finds the port can drive the browser, so it is only as private as the
//! local machine; set `PRINTNINJA_EDGE_PERSISTENT=0` to use one-shot Edge only.
//!
//! The protocol logic is platform independent so tests can drive it with a
//! fake DevTools server. Only the Edge lookup (in `mod.rs`) and the no-console
//! flag below are Windows-specific.
// Only Windows calls into this module; the unit tests build it everywhere.
#![cfg_attr(not(windows), allow(dead_code))]

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

/// Profile directory, inside the cache dir, of the persistent browser.
///
/// Not named `edge-profile-*` (the startup sweep removes those) and not the
/// one-shot launcher's `edge-warm-profile`: two Edge processes must never
/// share a profile directory.
pub const PERSISTENT_PROFILE_DIR: &str = "edge-cdp-profile";

/// Environment switch: `0` turns the persistent browser off.
pub const ENV_SWITCH: &str = "PRINTNINJA_EDGE_PERSISTENT";

/// Longest wait for Edge to come up and publish its debugging port.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(15);
/// After a failed start, how long callers go straight to the one-shot path.
const RETRY_AFTER: Duration = Duration::from_secs(60);
/// One protocol call.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// Navigation to the `load` event.
const LOAD_TIMEOUT: Duration = Duration::from_secs(30);
/// A whole render, tab open to tab close.
const JOB_TIMEOUT: Duration = Duration::from_secs(60);
/// A printed PDF or screenshot arrives as one base64 WebSocket message.
const MAX_MESSAGE: usize = 256 << 20;

/// Whether the persistent browser may be used at all.
pub fn enabled() -> bool {
    std::env::var(ENV_SWITCH).map_or(true, |v| v.trim() != "0")
}

/// How to start the persistent browser.
#[derive(Clone, Debug)]
pub struct Config {
    pub edge: PathBuf,
    /// The browser's own profile directory.
    pub profile: PathBuf,
    /// Placed before every other argument. Empty for Edge; the unit tests run
    /// `sh script.sh <args>`, where a leading switch would be read by `sh`.
    pub leading_args: Vec<String>,
    /// Placed after the standard arguments (the tests pass `--no-sandbox`
    /// for a root-run Chromium here).
    pub extra_args: Vec<String>,
}

impl Config {
    pub fn new(edge: &Path, cache_dir: &Path) -> Self {
        Self {
            edge: edge.to_path_buf(),
            profile: cache_dir.join(PERSISTENT_PROFILE_DIR),
            leading_args: Vec::new(),
            extra_args: Vec::new(),
        }
    }
}

// ── DevTools connection ─────────────────────────────────────────────────

/// A protocol event, as broadcast to everyone waiting for one.
#[derive(Clone, Debug)]
struct Event {
    method: String,
    session_id: Option<String>,
}

type Pending = Arc<StdMutex<HashMap<u64, oneshot::Sender<std::result::Result<Value, String>>>>>;

/// One WebSocket to the browser, shared by every job.
pub struct Connection {
    out: mpsc::UnboundedSender<String>,
    pending: Pending,
    events: broadcast::Sender<Event>,
    next_id: AtomicU64,
    closed: Arc<AtomicBool>,
}

impl Connection {
    /// Connect to `ws://host:port/path`.
    async fn connect(url: &str) -> Result<Arc<Self>> {
        let host = url
            .strip_prefix("ws://")
            .and_then(|r| r.split('/').next())
            .ok_or_else(|| anyhow!("not a ws:// URL: {url}"))?;
        let tcp =
            tokio::time::timeout(Duration::from_secs(5), tokio::net::TcpStream::connect(host))
                .await
                .context("connecting to the DevTools port timed out")?
                .context("connecting to the DevTools port")?;
        let _ = tcp.set_nodelay(true);
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE))
            .max_frame_size(Some(MAX_MESSAGE));
        let (ws, _) = tokio_tungstenite::client_async_with_config(url, tcp, Some(config))
            .await
            .context("DevTools WebSocket handshake")?;
        let (mut sink, mut stream) = ws.split();

        let (out, mut out_rx) = mpsc::unbounded_channel::<String>();
        let pending: Pending = Arc::default();
        let (events, _) = broadcast::channel(1024);
        let closed = Arc::new(AtomicBool::new(false));

        // Writer: ends when the last `Connection` handle is dropped.
        tokio::spawn(async move {
            while let Some(text) = out_rx.recv().await {
                if sink.send(Message::text(text)).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });

        // Reader: routes replies by id, broadcasts events, and on the way
        // out fails everything still waiting. It holds no `Connection`, so
        // it cannot keep one alive.
        {
            let pending = pending.clone();
            let events = events.clone();
            let closed = closed.clone();
            tokio::spawn(async move {
                while let Some(Ok(msg)) = stream.next().await {
                    let Message::Text(text) = msg else {
                        if matches!(msg, Message::Close(_)) {
                            break;
                        }
                        continue;
                    };
                    let Ok(v) = serde_json::from_str::<Value>(text.as_str()) else {
                        continue;
                    };
                    if let Some(id) = v.get("id").and_then(Value::as_u64) {
                        let waiter = pending.lock().unwrap().remove(&id);
                        if let Some(tx) = waiter {
                            let _ = tx.send(match v.get("error") {
                                Some(e) => Err(e
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("DevTools error")
                                    .to_string()),
                                None => Ok(v.get("result").cloned().unwrap_or(Value::Null)),
                            });
                        }
                    } else if let Some(method) = v.get("method").and_then(Value::as_str) {
                        let _ = events.send(Event {
                            method: method.to_string(),
                            session_id: v
                                .get("sessionId")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                        });
                    }
                }
                // Flag first, then drain: a call that inserts after the drain
                // sees the flag (see `call`).
                closed.store(true, Ordering::SeqCst);
                let waiting: Vec<_> = pending.lock().unwrap().drain().collect();
                for (_, tx) in waiting {
                    let _ = tx.send(Err("the browser closed the connection".into()));
                }
            });
        }

        Ok(Arc::new(Self {
            out,
            pending,
            events,
            next_id: AtomicU64::new(1),
            closed,
        }))
    }

    fn is_open(&self) -> bool {
        !self.closed.load(Ordering::SeqCst)
    }

    /// One request, optionally on a page's session. Resolves to the reply's
    /// `result`.
    async fn call(&self, session: Option<&str>, method: &str, params: Value) -> Result<Value> {
        if !self.is_open() {
            bail!("the browser connection is closed ({method})");
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            msg["sessionId"] = json!(s);
        }
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        // Closed between the check above and the insert: the reader may
        // already have drained `pending`, so nobody would answer.
        if !self.is_open() {
            self.pending.lock().unwrap().remove(&id);
            bail!("the browser connection is closed ({method})");
        }
        if self.out.send(msg.to_string()).is_err() {
            self.pending.lock().unwrap().remove(&id);
            bail!("the browser connection is closed ({method})");
        }
        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => Err(anyhow!("{method}: {e}")),
            Ok(Err(_)) => Err(anyhow!("{method}: no reply (connection dropped)")),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(anyhow!(
                    "{method}: no reply within {}s",
                    CALL_TIMEOUT.as_secs()
                ))
            }
        }
    }
}

// ── One tab ─────────────────────────────────────────────────────────────

/// A tab (CDP target plus session) that has loaded a document.
struct Page<'a> {
    conn: &'a Connection,
    target_id: String,
    session: String,
}

impl<'a> Page<'a> {
    /// Open a tab on `url` and wait until it has loaded, fonts included.
    /// `viewport` is the window size in CSS px for a screenshot (1 px = 1
    /// printer dot, no scaling).
    async fn open(
        conn: &'a Connection,
        url: &str,
        viewport: Option<(u32, u32)>,
    ) -> Result<Page<'a>> {
        let created = conn
            .call(None, "Target.createTarget", json!({ "url": "about:blank" }))
            .await?;
        let target_id = created["targetId"]
            .as_str()
            .ok_or_else(|| anyhow!("Target.createTarget returned no targetId"))?
            .to_string();
        match Self::attach_and_load(conn, &target_id, url, viewport).await {
            Ok(session) => Ok(Page {
                conn,
                target_id,
                session,
            }),
            Err(e) => {
                // Do not leak the tab of a job that failed to load.
                let _ = conn
                    .call(None, "Target.closeTarget", json!({ "targetId": target_id }))
                    .await;
                Err(e)
            }
        }
    }

    async fn attach_and_load(
        conn: &Connection,
        target_id: &str,
        url: &str,
        viewport: Option<(u32, u32)>,
    ) -> Result<String> {
        let attached = conn
            .call(
                None,
                "Target.attachToTarget",
                json!({ "targetId": target_id, "flatten": true }),
            )
            .await?;
        let session = attached["sessionId"]
            .as_str()
            .ok_or_else(|| anyhow!("Target.attachToTarget returned no sessionId"))?
            .to_string();
        let s = Some(session.as_str());

        conn.call(s, "Page.enable", json!({})).await?;
        if let Some((w, h)) = viewport {
            conn.call(
                s,
                "Emulation.setDeviceMetricsOverride",
                json!({ "width": w, "height": h, "deviceScaleFactor": 1, "mobile": false }),
            )
            .await?;
            conn.call(
                s,
                "Emulation.setScrollbarsHidden",
                json!({ "hidden": true }),
            )
            .await?;
        }

        // Subscribe before navigating: `load` must not be missed.
        let mut events = conn.events.subscribe();
        let nav = conn.call(s, "Page.navigate", json!({ "url": url })).await?;
        if let Some(err) = nav.get("errorText").and_then(Value::as_str) {
            bail!("the page did not load: {err}");
        }
        let deadline = Instant::now() + LOAD_TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(left, events.recv()).await {
                Ok(Ok(ev))
                    if ev.method == "Page.loadEventFired"
                        && ev.session_id.as_deref() == Some(session.as_str()) =>
                {
                    break
                }
                Ok(Ok(_)) => {}
                // Fell behind the event stream: the `load` we wait for may
                // have gone by. The document state says whether it did.
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => {
                    let ready = conn
                        .call(
                            s,
                            "Runtime.evaluate",
                            json!({
                                "expression": "document.readyState === 'complete'",
                                "returnByValue": true
                            }),
                        )
                        .await?;
                    if ready["result"]["value"].as_bool() == Some(true) {
                        break;
                    }
                }
                Ok(Err(broadcast::error::RecvError::Closed)) => {
                    bail!("the browser connection closed while the page loaded")
                }
                Err(_) => bail!(
                    "the page did not finish loading in {}s",
                    LOAD_TIMEOUT.as_secs()
                ),
            }
        }

        // Web fonts decide the layout; the old one-shot path got this from
        // headless Edge's own settle time.
        conn.call(
            s,
            "Runtime.evaluate",
            json!({
                "expression": "document.fonts ? document.fonts.ready.then(() => true) : true",
                "awaitPromise": true,
                "returnByValue": true
            }),
        )
        .await?;
        Ok(session)
    }

    /// `Page.printToPDF` at the document's own `@page` size and margins.
    async fn print_pdf(&self) -> Result<Vec<u8>> {
        let r = self
            .conn
            .call(
                Some(&self.session),
                "Page.printToPDF",
                json!({
                    "printBackground": true,
                    "preferCSSPageSize": true,
                    "displayHeaderFooter": false,
                }),
            )
            .await?;
        decode(&r, "Page.printToPDF")
    }

    /// `Page.captureScreenshot` of the viewport as a PNG.
    async fn screenshot(&self) -> Result<Vec<u8>> {
        let r = self
            .conn
            .call(
                Some(&self.session),
                "Page.captureScreenshot",
                json!({ "format": "png", "fromSurface": true }),
            )
            .await?;
        decode(&r, "Page.captureScreenshot")
    }

    async fn close(self) {
        let _ = self
            .conn
            .call(
                None,
                "Target.closeTarget",
                json!({ "targetId": self.target_id }),
            )
            .await;
    }
}

fn decode(result: &Value, method: &str) -> Result<Vec<u8>> {
    let data = result["data"]
        .as_str()
        .ok_or_else(|| anyhow!("{method} returned no data"))?;
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .with_context(|| format!("{method}: data is not base64"))
}

// ── The browser process ─────────────────────────────────────────────────

struct Browser {
    conn: Arc<Connection>,
    child: tokio::sync::Mutex<tokio::process::Child>,
}

/// Parse Edge's `DevToolsActivePort`: the port on line one, the browser's
/// WebSocket path on line two. A half-written file yields `None`.
fn parse_active_port(text: &str) -> Option<(u16, String)> {
    let mut lines = text.lines();
    let port: u16 = lines.next()?.trim().parse().ok()?;
    let path = lines.next()?.trim();
    (port != 0 && path.starts_with('/')).then(|| (port, path.to_string()))
}

impl Browser {
    async fn launch(cfg: &Config) -> Result<Browser> {
        tokio::fs::create_dir_all(&cfg.profile)
            .await
            .context("creating the browser profile directory")?;
        reap_orphan(&cfg.profile).await;

        let mut cmd = tokio::process::Command::new(&cfg.edge);
        cmd.args(&cfg.leading_args)
            .args([
                "--headless",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--disable-extensions",
                "--disable-sync",
                "--remote-debugging-port=0",
            ])
            .arg(format!("--user-data-dir={}", cfg.profile.to_string_lossy()))
            .args(&cfg.extra_args)
            .arg("about:blank")
            // Piped output nobody reads would eventually block Edge.
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(windows::Win32::System::Threading::CREATE_NO_WINDOW.0);
        let mut child = cmd.spawn().context("starting Edge")?;

        let active = cfg.profile.join("DevToolsActivePort");
        let deadline = Instant::now() + LAUNCH_TIMEOUT;
        let (port, path) = loop {
            if let Some(status) = child.try_wait()? {
                bail!(
                    "Edge exited while starting ({status}); the profile may be in use by another Edge"
                );
            }
            if let Some(found) = tokio::fs::read_to_string(&active)
                .await
                .ok()
                .and_then(|t| parse_active_port(&t))
            {
                break found;
            }
            if Instant::now() >= deadline {
                let _ = child.kill().await;
                bail!(
                    "Edge did not publish a DevTools port within {}s",
                    LAUNCH_TIMEOUT.as_secs()
                );
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        };

        let conn = match Connection::connect(&format!("ws://127.0.0.1:{port}{path}")).await {
            Ok(c) => c,
            Err(e) => {
                let _ = child.kill().await;
                return Err(e);
            }
        };
        match conn.call(None, "Browser.getVersion", json!({})).await {
            Ok(v) => tracing::info!(
                product = v["product"].as_str().unwrap_or("?"),
                port,
                "persistent Edge started"
            ),
            Err(e) => {
                let _ = child.kill().await;
                return Err(e);
            }
        }
        Ok(Browser {
            conn,
            child: tokio::sync::Mutex::new(child),
        })
    }

    async fn stop(&self) {
        if self.conn.is_open() {
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                self.conn.call(None, "Browser.close", json!({})),
            )
            .await;
        }
        let mut child = self.child.lock().await;
        // `close` normally ends the process on its own; make sure.
        if tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
    }
}

/// A previous run of the app that crashed leaves its Edge running on this
/// profile, and the new Edge would then hand off to it and exit. The old one
/// published its port in `DevToolsActivePort`: ask it to close, then clear
/// the file so a stale port is never mistaken for the new Edge's.
async fn reap_orphan(profile: &Path) {
    let file = profile.join("DevToolsActivePort");
    if let Ok(text) = tokio::fs::read_to_string(&file).await {
        if let Some((port, path)) = parse_active_port(&text) {
            let url = format!("ws://127.0.0.1:{port}{path}");
            if let Ok(Ok(conn)) =
                tokio::time::timeout(Duration::from_secs(2), Connection::connect(&url)).await
            {
                tracing::info!(port, "closing Edge left over from a previous run");
                let _ = tokio::time::timeout(
                    Duration::from_secs(2),
                    conn.call(None, "Browser.close", json!({})),
                )
                .await;
                // Let it release the profile.
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        }
    }
    let _ = tokio::fs::remove_file(&file).await;
}

// ── The shared handle ───────────────────────────────────────────────────

#[derive(Default)]
struct State {
    browser: Option<Arc<Browser>>,
    /// When the last start failed; see [`RETRY_AFTER`].
    failed_at: Option<Instant>,
}

#[derive(Default)]
pub struct PersistentEdge {
    state: tokio::sync::Mutex<State>,
}

/// The browser every render in this process goes through.
pub fn shared() -> &'static PersistentEdge {
    static EDGE: OnceLock<PersistentEdge> = OnceLock::new();
    EDGE.get_or_init(PersistentEdge::default)
}

impl PersistentEdge {

    /// The running browser, started (or restarted after a crash) if needed.
    /// Jobs that arrive during a start wait for it on the state lock rather
    /// than each starting their own.
    async fn browser(&self, cfg: &Config) -> Result<Arc<Browser>> {
        let mut st = self.state.lock().await;
        if let Some(b) = &st.browser {
            if b.conn.is_open() {
                return Ok(b.clone());
            }
            tracing::warn!("persistent Edge is gone; starting a new one");
            if let Some(dead) = st.browser.take() {
                dead.stop().await;
            }
        }
        if let Some(at) = st.failed_at {
            if at.elapsed() < RETRY_AFTER {
                bail!("persistent Edge failed to start recently; using one-shot Edge");
            }
        }
        match Browser::launch(cfg).await {
            Ok(b) => {
                let b = Arc::new(b);
                st.failed_at = None;
                st.browser = Some(b.clone());
                Ok(b)
            }
            Err(e) => {
                st.failed_at = Some(Instant::now());
                Err(e)
            }
        }
    }

    /// Start the browser now (app start-up), so the first print finds it
    /// running.
    pub async fn start(&self, cfg: &Config) -> Result<()> {
        self.browser(cfg).await.map(|_| ())
    }

    /// Print the document at `url` (a `file:///` URL) to a PDF.
    pub async fn print_pdf(&self, cfg: &Config, url: &str) -> Result<Vec<u8>> {
        let browser = self.browser(cfg).await?;
        let conn = browser.conn.clone();
        let job = async {
            let page = Page::open(&conn, url, None).await?;
            let result = page.print_pdf().await;
            page.close().await;
            result
        };
        tokio::time::timeout(JOB_TIMEOUT, job)
            .await
            .map_err(|_| anyhow!("PDF render timed out after {}s", JOB_TIMEOUT.as_secs()))?
    }

    /// Screenshot the document at `url` in a `w_px`×`h_px` window, as PNG.
    pub async fn screenshot(
        &self,
        cfg: &Config,
        url: &str,
        w_px: u32,
        h_px: u32,
    ) -> Result<Vec<u8>> {
        let browser = self.browser(cfg).await?;
        let conn = browser.conn.clone();
        let job = async {
            let page = Page::open(&conn, url, Some((w_px, h_px))).await?;
            let result = page.screenshot().await;
            page.close().await;
            result
        };
        tokio::time::timeout(JOB_TIMEOUT, job)
            .await
            .map_err(|_| anyhow!("screenshot timed out after {}s", JOB_TIMEOUT.as_secs()))?
    }

    /// Close the browser. Called when the app exits: the handle is a
    /// `static`, so nothing drops it and `kill_on_drop` never runs.
    pub async fn shutdown(&self) {
        let browser = self.state.lock().await.browser.take();
        if let Some(b) = browser {
            b.stop().await;
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn active_port_file_is_parsed() {
        assert_eq!(
            parse_active_port("9222\n/devtools/browser/abc-123\n"),
            Some((9222, "/devtools/browser/abc-123".into()))
        );
        assert_eq!(
            parse_active_port("9222\r\n/devtools/browser/x"),
            Some((9222, "/devtools/browser/x".into()))
        );
        // Half-written, empty or nonsense: not ready yet.
        assert_eq!(parse_active_port("9222\n"), None);
        assert_eq!(parse_active_port("9222"), None);
        assert_eq!(parse_active_port(""), None);
        assert_eq!(parse_active_port("0\n/devtools/browser/x"), None);
        assert_eq!(parse_active_port("abc\n/devtools/browser/x"), None);
        assert_eq!(parse_active_port("9222\nnot-a-path"), None);
    }

    /// A DevTools server that answers just enough of the protocol for a
    /// render, and records what it was asked.
    #[derive(Clone, Default)]
    struct Fake {
        log: Arc<StdMutex<Vec<String>>>,
        sessions: Arc<AtomicU64>,
    }

    impl Fake {
        fn methods(&self) -> Vec<String> {
            self.log.lock().unwrap().clone()
        }

        async fn serve(&self) -> u16 {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let this = self.clone();
            tokio::spawn(async move {
                while let Ok((tcp, _)) = listener.accept().await {
                    let this = this.clone();
                    tokio::spawn(async move {
                        let Ok(ws) = tokio_tungstenite::accept_async(tcp).await else {
                            return;
                        };
                        let (sink, mut stream) = ws.split();
                        let sink = Arc::new(tokio::sync::Mutex::new(sink));
                        while let Some(Ok(Message::Text(t))) = stream.next().await {
                            let v: Value = serde_json::from_str(t.as_str()).unwrap();
                            let id = v["id"].clone();
                            let method = v["method"].as_str().unwrap().to_string();
                            let session = v["sessionId"].as_str().map(str::to_string);
                            this.log.lock().unwrap().push(method.clone());
                            let result = match method.as_str() {
                                "Target.createTarget" => json!({ "targetId": "T" }),
                                "Target.attachToTarget" => json!({
                                    "sessionId": format!("S{}", this.sessions.fetch_add(1, Ordering::SeqCst))
                                }),
                                "Page.navigate" => {
                                    let url = v["params"]["url"].as_str().unwrap_or("");
                                    if url.contains("missing") {
                                        json!({ "errorText": "net::ERR_FILE_NOT_FOUND" })
                                    } else {
                                        json!({ "frameId": "F" })
                                    }
                                }
                                "Runtime.evaluate" => json!({ "result": { "value": true } }),
                                "Page.printToPDF" => json!({ "data": "JVBERi1mYWtl" }), // %PDF-fake
                                "Page.captureScreenshot" => json!({ "data": "UE5HRkFLRQ==" }), // PNGFAKE
                                _ => json!({}),
                            };
                            let reply = json!({ "id": id, "result": result });
                            let mut s = sink.lock().await;
                            s.send(Message::text(reply.to_string())).await.unwrap();
                            // `load` follows a successful navigation, on the
                            // session that asked for it.
                            if method == "Page.navigate" && result.get("errorText").is_none() {
                                let ev = json!({
                                    "method": "Page.loadEventFired",
                                    "sessionId": session,
                                    "params": {}
                                });
                                s.send(Message::text(ev.to_string())).await.unwrap();
                            }
                            if method == "Browser.close" {
                                let _ = s.close().await;
                                return;
                            }
                        }
                    });
                }
            });
            port
        }
    }

    /// A stand-in for Edge, run as `sh <script> <args…>`: publishes the fake
    /// server's port the way Edge does, counts its starts, then idles.
    fn fake_edge(cache: &Path, port: u16) -> Config {
        let script = cache.join("fake-edge.sh");
        std::fs::write(
            &script,
            format!(
                r#"
for a in "$@"; do
  case "$a" in --user-data-dir=*) profile="${{a#--user-data-dir=}}";; esac
done
mkdir -p "$profile"
echo start >> "$profile/starts"
printf '%s\n%s\n' {port} /devtools/browser/fake > "$profile/DevToolsActivePort"
exec sleep 60
"#
            ),
        )
        .unwrap();
        let mut cfg = Config::new(Path::new("/bin/sh"), cache);
        cfg.leading_args = vec![script.to_string_lossy().into_owned()];
        cfg
    }

    struct Rig {
        cache: PathBuf,
    }
    impl Rig {
        fn new() -> Self {
            let cache = std::env::temp_dir().join(format!("pn-cdp-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&cache).unwrap();
            Rig { cache }
        }
        fn starts(&self) -> usize {
            std::fs::read_to_string(self.cache.join(PERSISTENT_PROFILE_DIR).join("starts"))
                .map_or(0, |t| t.lines().count())
        }
    }
    impl Drop for Rig {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.cache);
        }
    }

    #[tokio::test]
    async fn a_pdf_render_opens_prints_and_closes_one_tab() {
        let rig = Rig::new();
        let fake = Fake::default();
        let cfg = fake_edge(&rig.cache, fake.serve().await);
        let edge = PersistentEdge::default();

        let pdf = edge.print_pdf(&cfg, "file:///x.html").await.unwrap();

        assert_eq!(pdf, b"%PDF-fake");
        let m = fake.methods();
        let pos = |name: &str| m.iter().position(|x| x == name).unwrap();
        assert!(pos("Target.createTarget") < pos("Target.attachToTarget"));
        assert!(pos("Page.navigate") < pos("Page.printToPDF"));
        assert_eq!(
            m.last().unwrap(),
            "Target.closeTarget",
            "the tab is closed last"
        );
        assert!(
            !m.iter().any(|x| x.starts_with("Emulation")),
            "no viewport for a PDF"
        );
        edge.shutdown().await;
    }

    #[tokio::test]
    async fn a_screenshot_sets_the_window_size_first() {
        let rig = Rig::new();
        let fake = Fake::default();
        let cfg = fake_edge(&rig.cache, fake.serve().await);
        let edge = PersistentEdge::default();

        let png = edge
            .screenshot(&cfg, "file:///x.html", 812, 406)
            .await
            .unwrap();

        assert_eq!(png, b"PNGFAKE");
        let m = fake.methods();
        let pos = |name: &str| m.iter().position(|x| x == name).unwrap();
        assert!(pos("Emulation.setDeviceMetricsOverride") < pos("Page.navigate"));
        assert!(pos("Page.navigate") < pos("Page.captureScreenshot"));
        edge.shutdown().await;
    }

    /// The point of the change: many prints, one Edge process.
    #[tokio::test]
    async fn jobs_share_one_browser_process_even_when_concurrent() {
        let rig = Rig::new();
        let fake = Fake::default();
        let cfg = fake_edge(&rig.cache, fake.serve().await);
        let edge = Arc::new(PersistentEdge::default());

        let mut jobs = Vec::new();
        for i in 0..8 {
            let (edge, cfg) = (edge.clone(), cfg.clone());
            jobs.push(tokio::spawn(async move {
                edge.print_pdf(&cfg, &format!("file:///{i}.html")).await
            }));
        }
        for j in jobs {
            assert_eq!(j.await.unwrap().unwrap(), b"%PDF-fake");
        }

        assert_eq!(rig.starts(), 1, "eight jobs, one Edge start");
        assert_eq!(
            fake.sessions.load(Ordering::SeqCst),
            8,
            "each job had its own tab"
        );
        edge.shutdown().await;
    }

    #[tokio::test]
    async fn a_page_that_fails_to_load_is_an_error_and_its_tab_is_closed() {
        let rig = Rig::new();
        let fake = Fake::default();
        let cfg = fake_edge(&rig.cache, fake.serve().await);
        let edge = PersistentEdge::default();

        let err = edge
            .print_pdf(&cfg, "file:///missing.html")
            .await
            .unwrap_err();

        assert!(err.to_string().contains("ERR_FILE_NOT_FOUND"), "{err}");
        assert_eq!(fake.methods().last().unwrap(), "Target.closeTarget");
        // The browser itself is fine: the next job works.
        assert!(edge.print_pdf(&cfg, "file:///ok.html").await.is_ok());
        assert_eq!(rig.starts(), 1);
        edge.shutdown().await;
    }

    /// A crashed or closed browser is replaced on the next job.
    #[tokio::test]
    async fn a_closed_browser_is_restarted() {
        let rig = Rig::new();
        let fake = Fake::default();
        let cfg = fake_edge(&rig.cache, fake.serve().await);
        let edge = PersistentEdge::default();
        edge.print_pdf(&cfg, "file:///a.html").await.unwrap();

        // The browser goes away under us.
        let browser = edge.browser(&cfg).await.unwrap();
        let _ = browser.conn.call(None, "Browser.close", json!({})).await;
        for _ in 0..100 {
            if !browser.conn.is_open() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(!browser.conn.is_open(), "the reader noticed the close");

        edge.print_pdf(&cfg, "file:///b.html").await.unwrap();
        assert_eq!(rig.starts(), 2, "a second Edge was started");
        edge.shutdown().await;
    }

    /// Where Edge cannot be started at all, the caller gets an error at once
    /// (to fall back on one-shot Edge) and later jobs do not retry for a while.
    #[tokio::test]
    async fn a_failed_start_is_an_error_and_not_retried_at_once() {
        let rig = Rig::new();
        let cfg = Config::new(&rig.cache.join("no-such-edge"), &rig.cache);
        let edge = PersistentEdge::default();

        assert!(edge.print_pdf(&cfg, "file:///a.html").await.is_err());
        let t = Instant::now();
        let again = edge.print_pdf(&cfg, "file:///a.html").await.unwrap_err();
        assert!(
            again.to_string().contains("failed to start recently"),
            "{again}"
        );
        assert!(t.elapsed() < Duration::from_secs(1));
    }

    /// An Edge that exits straight away (profile in use elsewhere) is
    /// reported, not waited on for the whole launch timeout.
    #[tokio::test]
    async fn an_edge_that_exits_while_starting_is_reported_quickly() {
        let rig = Rig::new();
        let cfg = Config::new(Path::new("/bin/true"), &rig.cache);
        let edge = PersistentEdge::default();

        let t = Instant::now();
        let err = edge.start(&cfg).await.unwrap_err();

        assert!(err.to_string().contains("exited while starting"), "{err}");
        assert!(t.elapsed() < Duration::from_secs(5));
    }

    /// An Edge left over from a crashed run is asked to close, and its stale
    /// port file is cleared.
    #[tokio::test]
    async fn a_leftover_edge_is_closed_and_its_port_file_cleared() {
        let rig = Rig::new();
        let fake = Fake::default();
        let port = fake.serve().await;
        let profile = rig.cache.join(PERSISTENT_PROFILE_DIR);
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(
            profile.join("DevToolsActivePort"),
            format!("{port}\n/devtools/browser/old\n"),
        )
        .unwrap();

        reap_orphan(&profile).await;

        assert!(fake.methods().contains(&"Browser.close".to_string()));
        assert!(!profile.join("DevToolsActivePort").exists());
    }

    /// Against a real Chromium-family browser, for checking the protocol
    /// itself. Skipped unless `PRINTNINJA_TEST_EDGE` names the executable;
    /// `PRINTNINJA_TEST_EDGE_ARGS` adds switches (`--no-sandbox` as root).
    #[tokio::test]
    async fn a_real_browser_prints_and_screenshots() {
        let Ok(exe) = std::env::var("PRINTNINJA_TEST_EDGE") else {
            eprintln!("skipped: PRINTNINJA_TEST_EDGE is not set");
            return;
        };
        let rig = Rig::new();
        let mut cfg = Config::new(Path::new(&exe), &rig.cache);
        cfg.extra_args = std::env::var("PRINTNINJA_TEST_EDGE_ARGS")
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_string)
            .collect();
        let html = rig.cache.join("label.html");
        std::fs::write(
            &html,
            "<!doctype html><meta charset=utf-8><style>@page{size:50mm 30mm;margin:5mm}\
             body{margin:0;font:12px Arial}</style><body>HELLO</body>",
        )
        .unwrap();
        let url = format!("file://{}", html.display());
        let edge = PersistentEdge::default();

        let pdf = edge.print_pdf(&cfg, &url).await.unwrap();
        assert!(pdf.starts_with(b"%PDF"));

        let png = edge.screenshot(&cfg, &url, 400, 240).await.unwrap();
        assert!(png.starts_with(b"\x89PNG"));
        let (w, h) = (
            u32::from_be_bytes(png[16..20].try_into().unwrap()),
            u32::from_be_bytes(png[20..24].try_into().unwrap()),
        );
        assert_eq!((w, h), (400, 240), "1 CSS px is 1 dot");

        // Several at once, in tabs of the same browser.
        let edge = Arc::new(edge);
        let jobs: Vec<_> = (0..4)
            .map(|_| {
                let (edge, cfg, url) = (edge.clone(), cfg.clone(), url.clone());
                tokio::spawn(async move { edge.print_pdf(&cfg, &url).await })
            })
            .collect();
        for j in jobs {
            assert!(j.await.unwrap().unwrap().starts_with(b"%PDF"));
        }
        edge.shutdown().await;
    }
}
