//! Phase 0 print-correctness tests (item 0.3).
//!
//! - P5: with no browser available the render fails; the stub "PrintNinja"
//!   PDF is gone and the job is recorded as failed.
//! - P6: every render writes its own file, so two parallel jobs cannot hand
//!   each other's HTML to a printer.
//! - P7: an HTTP `200` with an IPP error status in the body is a failure —
//!   for the transport and for the job.
//! - P14: the template engine always runs (with the job's data or an empty
//!   context, like the preview) and a template error fails the job instead of
//!   printing the raw source.
//! - P15: the job row exists from the start with the real start time, shows
//!   `printing` while it runs, and a render failure still reports the row's
//!   own id.
//!
//! The pipeline is driven through `run_print_with`, which substitutes only
//! the render step; layout, the queue permit, the transport and the history
//! row are the real code.

#[cfg(not(windows))]
use printninja_lib::commands::print::run_print;
use printninja_lib::commands::print::{run_print_with, JobRenderer, PrintRequest};
use printninja_lib::db::Database;
use printninja_lib::queue::PrintQueue;
use printninja_lib::render::PdfRenderer;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

type Db = Arc<Mutex<Database>>;

fn test_db() -> Db {
    let path = std::env::temp_dir().join(format!("printninja_print_{}.db", uuid::Uuid::new_v4()));
    let db = Database::open(&format!("sqlite:{}", path.display())).expect("open db");
    Arc::new(Mutex::new(db))
}

fn cache_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("printninja_p03_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("create cache dir");
    dir
}

fn seed_printer(db: &Db, name: &str, address: &str) {
    let guard = db.lock().unwrap();
    guard
        .connection()
        .execute(
            "INSERT INTO printers (name, type, address, language) VALUES (?1, 'ipp', ?2, 'pdf')",
            rusqlite::params![name, address],
        )
        .expect("seed printer");
}

fn print_request(printer: &str) -> PrintRequest {
    PrintRequest {
        printer_name: printer.to_string(),
        html: "<html><body><p>label</p></body></html>".to_string(),
        page_width_mm: Some(100.0),
        page_height_mm: Some(150.0),
        orientation: Some("portrait".to_string()),
        copies: Some(1),
        margin_top: None,
        margin_right: None,
        margin_bottom: None,
        margin_left: None,
        fit_mode: None,
        template_id: None,
        template_version_id: None,
        data: None,
        data_url: None,
        test: None,
        source: Some("ui".to_string()),
        idempotency_key: None,
    }
}

/// The single job row: `(id, status, started_at, finished_at, duration_ms, error)`.
fn only_job(
    db: &Db,
) -> (
    i64,
    String,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<String>,
) {
    let guard = db.lock().unwrap();
    guard
        .connection()
        .query_row(
            "SELECT id, status, started_at, finished_at, duration_ms, error FROM print_jobs",
            [],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .expect("one job row")
}

/// Stands in for Edge: produces bytes without a browser. Everything else in
/// the pipeline is the real code.
struct FakeRenderer;

#[async_trait::async_trait]
impl JobRenderer for FakeRenderer {
    async fn render(
        &self,
        _final_html: &str,
        _w_mm: f64,
        _h_mm: f64,
        _orientation: &str,
    ) -> anyhow::Result<Vec<u8>> {
        Ok(b"%PDF-1.4 fake-render".to_vec())
    }
}

/// Signals when rendering has started, then waits for permission to finish,
/// so a test can look at the database *while* the job runs (P15).
struct HoldingRenderer {
    started: tokio::sync::mpsc::UnboundedSender<()>,
    gate: Arc<tokio::sync::Notify>,
}

#[async_trait::async_trait]
impl JobRenderer for HoldingRenderer {
    async fn render(
        &self,
        _final_html: &str,
        _w_mm: f64,
        _h_mm: f64,
        _orientation: &str,
    ) -> anyhow::Result<Vec<u8>> {
        let _ = self.started.send(());
        self.gate.notified().await;
        Ok(b"%PDF-1.4 holding-render".to_vec())
    }
}

/// A local HTTP listener that drains the request and answers with HTTP `200`
/// plus an IPP response body whose status code is `status`. Returns the
/// `host:port` to store as the printer's address.
fn mock_ipp_server(status: u16) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind mock IPP server");
    let addr = listener.local_addr().expect("mock address");
    let body = ipp_response(status);
    std::thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .ok();
        // Drain headers and Content-Length bytes of body, so the client never
        // sees a reset while it is still sending.
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        let want = loop {
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&buf[..pos]).to_ascii_lowercase();
                let cl = headers
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                break pos + 4 + cl;
            }
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break buf.len(),
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        };
        while buf.len() < want {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/ipp\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.write_all(&body);
    });
    format!("127.0.0.1:{}", addr.port())
}

/// RFC 8010 response: version 1.1, status, request-id 1, end-of-attributes.
fn ipp_response(status: u16) -> Vec<u8> {
    vec![
        0x01,
        0x01,
        (status >> 8) as u8,
        status as u8,
        0x00,
        0x00,
        0x00,
        0x01,
        0x03,
    ]
}

// ───────────────────────────────────────────────────────────────
// P6
// ───────────────────────────────────────────────────────────────

/// Two jobs rendering at the same time each keep their own document. The
/// fixed `render.html` this replaces let one printer's job render another's
/// HTML.
#[tokio::test]
async fn parallel_renders_each_keep_their_own_html() {
    let dir = cache_dir();
    let a = PdfRenderer::new(dir.clone());
    let b = PdfRenderer::new(dir.clone());

    let (pa, va) = tokio::join!(
        a.write_job_html("<p>A-job</p>"),
        b.write_job_html("<p>B-job</p>")
    );
    let pa = pa.expect("job A writes");
    let va = va.expect("job B writes");

    assert_ne!(pa, va, "each job gets its own render file");
    assert_eq!(
        std::fs::read_to_string(&pa).expect("job A file"),
        "<p>A-job</p>"
    );
    assert_eq!(
        std::fs::read_to_string(&va).expect("job B file"),
        "<p>B-job</p>"
    );
}

/// P5/P6 tripwire: the renderer must contain neither the stub PDF nor a
/// fixed-name render file. Runs on every platform, including Windows where
/// the real renderer is exercised elsewhere.
#[test]
fn the_renderer_has_no_stub_pdf_and_no_shared_render_file() {
    let src = include_str!("../src/render/mod.rs");
    assert!(
        !src.contains("fallback_pdf"),
        "the stub path must be gone (P5)"
    );
    assert!(
        !src.contains("%PDF"),
        "no placeholder PDF bytes may return (P5)"
    );
    assert!(
        !src.contains("\"render.html\""),
        "the render file must be per-job, not fixed (P6)"
    );
}

// ───────────────────────────────────────────────────────────────
// P5
// ───────────────────────────────────────────────────────────────

#[cfg(not(windows))]
#[tokio::test]
async fn rendering_without_a_browser_fails_instead_of_returning_the_stub() {
    let dir = cache_dir();
    let renderer = PdfRenderer::new(dir.clone());

    let err = renderer
        .html_to_pdf("<html><body>hi</body></html>", 100.0, 50.0, "portrait")
        .await
        .expect_err("no renderer on this platform must fail, not return a stub PDF");
    let msg = format!("{err:#}");
    assert!(msg.contains("no PDF renderer"), "{msg}");

    // The per-job file is cleaned up, on the error path too.
    let leftovers: Vec<String> = std::fs::read_dir(&dir)
        .expect("cache dir")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("render-"))
        .collect();
    assert!(leftovers.is_empty(), "no per-job leftovers: {leftovers:?}");
}

/// A render failure fails the job — recorded, with the row's own id (P15's
/// "job_id is empty on a render failure") and never sent anywhere.
#[cfg(not(windows))]
#[tokio::test]
async fn a_render_failure_fails_the_job_with_its_own_id() {
    let db = test_db();
    seed_printer(&db, "Mock", "127.0.0.1:1");
    let queue = PrintQueue::new();

    let res = run_print(&cache_dir(), &db, &queue, print_request("Mock"))
        .await
        .expect("a render failure is an outcome, not a pipeline error");
    assert!(!res.success);
    let err = res.error.expect("the failure is reported");
    assert!(
        err.contains("no PDF renderer"),
        "failed at the render step: {err}"
    );
    assert!(
        !res.job_id.is_empty(),
        "even a failed render reports its job id"
    );

    let (id, status, started_at, finished_at, duration, error) = only_job(&db);
    assert_eq!(res.job_id, id.to_string());
    assert_eq!(status, "failed");
    assert!(
        started_at.is_some(),
        "started_at recorded when the job began"
    );
    assert!(finished_at.is_some(), "finished_at recorded when it failed");
    assert!(duration.is_some(), "duration recorded");
    assert!(
        error
            .as_deref()
            .is_some_and(|e| e.contains("no PDF renderer")),
        "the row carries the render error"
    );
}

// ───────────────────────────────────────────────────────────────
// P14
// ───────────────────────────────────────────────────────────────

/// A malformed template fails the job instead of printing the raw source.
#[tokio::test]
async fn a_template_error_fails_the_job_instead_of_printing_the_source() {
    let db = test_db();
    seed_printer(&db, "Mock", "127.0.0.1:1");
    let queue = PrintQueue::new();

    let mut req = print_request("Mock");
    req.html = "{{#if unclosed".to_string();

    let res = run_print_with(&cache_dir(), &db, &queue, req, &FakeRenderer)
        .await
        .expect("a template error is an outcome, not a pipeline error");
    assert!(!res.success);
    let err = res.error.expect("the failure is reported");
    assert!(err.contains("Template render failed"), "{err}");

    let (_, status, _, _, _, error) = only_job(&db);
    assert_eq!(status, "failed");
    assert!(
        error.is_some_and(|e| e.contains("Template render failed")),
        "the row carries the template error"
    );
}

/// Without data the engine still runs — with an empty context, exactly like
/// the preview — so `{{currency price}}` prints `$0.00`, not the literal
/// template text.
#[tokio::test]
async fn a_job_without_data_still_gets_its_template_rendered() {
    let db = test_db();
    let addr = mock_ipp_server(0x0000);
    seed_printer(&db, "Mock", &addr);
    let queue = PrintQueue::new();

    let mut req = print_request("Mock");
    req.html = "<p>Total: {{currency price}}</p>".to_string();

    let res = run_print_with(&cache_dir(), &db, &queue, req, &FakeRenderer)
        .await
        .expect("print succeeds");
    assert!(res.success, "{:?}", res.error);

    let guard = db.lock().unwrap();
    let stored: String = guard
        .connection()
        .query_row("SELECT rendered_html FROM print_jobs", [], |r| r.get(0))
        .expect("job row");
    assert!(
        stored.contains("$0.00"),
        "engine ran without data: {stored}"
    );
    assert!(
        !stored.contains("{{currency"),
        "no unrendered source: {stored}"
    );
}

// ───────────────────────────────────────────────────────────────
// P12
// ───────────────────────────────────────────────────────────────

/// Fails the test by panicking: a duplicate must end before the render
/// stage, so this renderer is never called.
struct PanicRenderer;

#[async_trait::async_trait]
impl JobRenderer for PanicRenderer {
    async fn render(
        &self,
        _final_html: &str,
        _w_mm: f64,
        _h_mm: f64,
        _orientation: &str,
    ) -> anyhow::Result<Vec<u8>> {
        panic!("a duplicate must never reach the render step");
    }
}

/// P12: the idempotency key is reserved by the `begin_job` INSERT under a
/// unique index — recorded before render and before send. The request that
/// loses that insert race gets `DuplicateJob` carrying the winner's id, and
/// no second pipeline run happens at all.
#[tokio::test]
async fn losing_the_insert_race_reports_the_existing_job_and_prints_nothing() {
    let db = test_db();
    seed_printer(&db, "Mock", "127.0.0.1:1");

    // The winner's row, exactly what the loser's INSERT collides with.
    let winner = {
        let guard = db.lock().unwrap();
        let conn = guard.connection();
        conn.execute(
            "INSERT INTO print_jobs (source, status, idempotency_key)
             VALUES ('api', 'printing', 'race-key')",
            [],
        )
        .expect("seed the winner row");
        conn.last_insert_rowid()
    };

    let queue = PrintQueue::new();
    let mut req = print_request("Mock");
    req.idempotency_key = Some("race-key".to_string());

    let err = run_print_with(&cache_dir(), &db, &queue, req, &PanicRenderer)
        .await
        .expect_err("the key is already taken");
    let id = match err {
        printninja_lib::AppError::DuplicateJob(id) => id,
        other => panic!("expected DuplicateJob, got {other:?}"),
    };
    assert_eq!(id, winner, "the loser is told which job owns the key");

    // One key, one row: nothing was recorded twice — and nothing rendered.
    let n: i64 = {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .query_row("SELECT COUNT(*) FROM print_jobs", [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(n, 1, "one key must keep exactly one job row");
}

// ───────────────────────────────────────────────────────────────
// P7
// ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn http_200_with_an_ipp_error_status_is_a_failure() {
    let addr = mock_ipp_server(0x0502); // server-error-service-unavailable
    let printer = printninja_lib::transport::ipp::IppPrinter::new("Mock".into(), addr);
    let err = printer
        .send_pdf(b"%PDF-1.4 fake", 1)
        .await
        .expect_err("an IPP error status must fail even behind HTTP 200");
    assert!(err.contains("0x0502"), "{err}");
}

#[tokio::test]
async fn http_200_with_an_ipp_success_status_prints() {
    let addr = mock_ipp_server(0x0000); // successful-ok
    let printer = printninja_lib::transport::ipp::IppPrinter::new("Mock".into(), addr);
    printer
        .send_pdf(b"%PDF-1.4 fake", 1)
        .await
        .expect("successful-ok is a success");
}

/// Job level, as section 11 puts it: the mock server answers HTTP `200` with
/// an IPP error status and the job must end `failed`.
#[tokio::test]
async fn a_job_the_printer_rejects_ends_failed() {
    let db = test_db();
    let addr = mock_ipp_server(0x0502);
    seed_printer(&db, "Mock", &addr);
    let queue = PrintQueue::new();

    let res = run_print_with(
        &cache_dir(),
        &db,
        &queue,
        print_request("Mock"),
        &FakeRenderer,
    )
    .await
    .expect("the pipeline reports a rejected job as an outcome");
    assert!(!res.success, "a rejected job must not report success");
    let err = res.error.expect("the rejection is reported");
    assert!(err.contains("0x0502"), "{err}");

    let (id, status, started_at, finished_at, _, error) = only_job(&db);
    assert_eq!(res.job_id, id.to_string());
    assert_eq!(status, "failed");
    assert!(started_at.is_some() && finished_at.is_some());
    assert!(
        error.as_deref().is_some_and(|e| e.contains("0x0502")),
        "the row carries the printer's status"
    );
}

// ───────────────────────────────────────────────────────────────
// P15
// ───────────────────────────────────────────────────────────────

/// The job row exists while the job runs: `printing`, started, not finished.
/// Then the print completes and the row reaches its terminal state.
#[tokio::test]
async fn a_running_job_shows_as_printing_and_then_finishes() {
    let db = test_db();
    let addr = mock_ipp_server(0x0000);
    seed_printer(&db, "Mock", &addr);
    let queue = PrintQueue::new();
    let cache = cache_dir();

    let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
    let gate = Arc::new(tokio::sync::Notify::new());
    let renderer = HoldingRenderer {
        started: started_tx,
        gate: gate.clone(),
    };

    let task_db = db.clone();
    let task_queue = queue.clone();
    let task = tokio::spawn(async move {
        run_print_with(
            &cache,
            &task_db,
            &task_queue,
            print_request("Mock"),
            &renderer,
        )
        .await
    });

    // The pipeline has reached the render step; nothing has finished yet.
    started_rx.recv().await.expect("render stage reached");

    let (id, status, started_at, finished_at, duration, _) = only_job(&db);
    assert_eq!(status, "printing", "a running job shows as printing");
    assert!(started_at.is_some(), "started_at was written at the start");
    assert!(finished_at.is_none(), "nothing finished yet");
    assert!(duration.is_none(), "nothing finished yet");

    gate.notify_one();
    let res = task
        .await
        .expect("join")
        .expect("print against the mock succeeds");
    assert!(res.success, "{:?}", res.error);
    assert_eq!(res.job_id, id.to_string());

    let (_, status, started_at, finished_at, duration, error) = only_job(&db);
    assert_eq!(status, "success");
    assert!(started_at.is_some() && finished_at.is_some());
    assert!(duration.is_some(), "real duration recorded");
    assert!(error.is_none());
}
