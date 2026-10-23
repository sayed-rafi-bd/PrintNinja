//! Phase 0 queue/worker tests (item 0.4, P3 + P8).
//!
//! Reprint, retry, batch and `POST /v1/print/batch` write `queued` rows;
//! without a worker nothing consumed them, so "queued" meant "never prints"
//! and batch `done`/`failed` never moved. These tests drive the real worker —
//! claim, batch counters, history write, transport — with only the render
//! substituted, the same seam item 0.3 built.

use printninja_lib::commands::history::{reprint_job_conn, retry_job_conn};
use printninja_lib::commands::print::JobRenderer;
use printninja_lib::db::Database;
use printninja_lib::queue::PrintQueue;
use printninja_lib::worker::Worker;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

type Db = Arc<Mutex<Database>>;

fn test_db() -> Db {
    let path = std::env::temp_dir().join(format!("printninja_worker_{}.db", uuid::Uuid::new_v4()));
    let db = Database::open(&format!("sqlite:{}", path.display())).expect("open db");
    Arc::new(Mutex::new(db))
}

fn cache_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("printninja_p04_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("create cache dir");
    dir
}

fn seed_printer(db: &Db, name: &str, address: &str) -> i64 {
    let guard = db.lock().unwrap();
    guard
        .connection()
        .execute(
            "INSERT INTO printers (name, type, address, language) VALUES (?1, 'ipp', ?2, 'pdf')",
            rusqlite::params![name, address],
        )
        .expect("seed printer");
    guard.connection().last_insert_rowid()
}

/// A template with a current version whose HTML uses the job's data.
fn seed_template(db: &Db) -> i64 {
    let guard = db.lock().unwrap();
    let conn = guard.connection();
    conn.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation, html, css)
         VALUES ('Shelf', 100, 150, 'portrait', '<p>{{n}}</p>', '')",
        [],
    )
    .expect("seed template");
    conn.last_insert_rowid()
}

/// A queued row the way reprint writes one: the content already rendered,
/// waiting for the worker.
fn queued_rendered_job(db: &Db, printer_id: i64, html: &str) -> i64 {
    let guard = db.lock().unwrap();
    let conn = guard.connection();
    conn.execute(
        "INSERT INTO print_jobs
           (printer_id, source, status, copies, rendered_html, is_test)
         VALUES (?1, 'ui', 'queued', 1, ?2, 0)",
        rusqlite::params![printer_id, html],
    )
    .expect("seed queued row");
    conn.last_insert_rowid()
}

fn job_state(db: &Db, id: i64) -> (String, Option<String>, Option<String>, Option<String>) {
    let guard = db.lock().unwrap();
    guard
        .connection()
        .query_row(
            "SELECT status, error, started_at, finished_at FROM print_jobs WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .expect("job row")
}

fn batch_state(db: &Db, id: i64) -> (String, i64, i64) {
    let guard = db.lock().unwrap();
    guard
        .connection()
        .query_row(
            "SELECT status, done, failed FROM batches WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .expect("batch row")
}

/// Stands in for the browser: counts renders, produces bytes. Everything
/// else in the worker path is the real code.
#[derive(Default)]
struct CountingRenderer {
    renders: AtomicUsize,
}

#[async_trait::async_trait]
impl JobRenderer for CountingRenderer {
    async fn render(
        &self,
        _final_html: &str,
        _w_mm: f64,
        _h_mm: f64,
        _orientation: &str,
    ) -> anyhow::Result<Vec<u8>> {
        self.renders.fetch_add(1, Ordering::SeqCst);
        Ok(b"%PDF-1.4 fake-render".to_vec())
    }
}

/// A local HTTP listener answering IPP `200` with status `status` in the
/// body. Serves connections until the process exits — jobs to one printer
/// are serialised, but a batch sends one request per job. Returns the
/// `host:port` to store as the printer's address.
fn mock_ipp_server(status: u16) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind mock IPP server");
    let addr = listener.local_addr().expect("mock address");
    let body = ipp_response(status);
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                .ok();
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
        }
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
// P3: the worker consumes queued rows
// ───────────────────────────────────────────────────────────────

/// A `queued` row is printed by the worker and ends `success` — it never
/// stays `queued` (the P3 regression: rows nothing consumed).
#[tokio::test]
async fn a_queued_job_is_printed_by_the_worker() {
    let db = test_db();
    let printer_id = seed_printer(&db, "Desk", &mock_ipp_server(0x0000));
    let job_id = queued_rendered_job(&db, printer_id, "<p>label</p>");

    let worker = Worker::new(db.clone(), PrintQueue::new(), cache_dir());
    let renderer = Arc::new(CountingRenderer::default());
    let ran = worker.drain(renderer.clone()).await;

    assert_eq!(ran, 1, "one queued row was claimed");
    assert_eq!(renderer.renders.load(Ordering::SeqCst), 1);
    let (status, error, started, finished) = job_state(&db, job_id);
    assert_eq!(status, "success", "queued job ends terminal: {error:?}");
    assert!(started.is_some(), "the claim stamps the real start time");
    assert!(finished.is_some());
}

/// Reprint queues a clone of the original job; the worker prints the clone.
#[tokio::test]
async fn a_reprint_is_queued_and_printed_by_the_worker() {
    let db = test_db();
    let printer_id = seed_printer(&db, "Desk", &mock_ipp_server(0x0000));
    let original = queued_rendered_job(&db, printer_id, "<p>original</p>");
    {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .execute(
                "UPDATE print_jobs SET status = 'success', started_at = datetime('now'),
                        finished_at = datetime('now') WHERE id = ?1",
                [original],
            )
            .unwrap();
    }
    let clone = {
        let guard = db.lock().unwrap();
        reprint_job_conn(guard.connection(), original).expect("reprint must queue a clone")
    };
    assert_eq!(clone.status, "queued");

    let worker = Worker::new(db.clone(), PrintQueue::new(), cache_dir());
    let ran = worker.drain(Arc::new(CountingRenderer::default())).await;

    assert_eq!(ran, 1);
    let (status, error, ..) = job_state(&db, clone.id);
    assert_eq!(status, "success", "the reprint clone is printed: {error:?}");
}

/// Retry re-queues the failed row; the worker finishes it.
#[tokio::test]
async fn a_retry_is_requeued_and_printed_by_the_worker() {
    let db = test_db();
    let printer_id = seed_printer(&db, "Desk", &mock_ipp_server(0x0000));
    let job_id = queued_rendered_job(&db, printer_id, "<p>label</p>");
    {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .execute(
                "UPDATE print_jobs SET status = 'failed', error = 'printer offline'
                 WHERE id = ?1",
                [job_id],
            )
            .unwrap();
        let retried = retry_job_conn(guard.connection(), job_id).expect("retry re-queues");
        assert_eq!(retried.status, "queued");
    }

    let worker = Worker::new(db.clone(), PrintQueue::new(), cache_dir());
    let ran = worker.drain(Arc::new(CountingRenderer::default())).await;

    assert_eq!(ran, 1);
    let (status, error, ..) = job_state(&db, job_id);
    assert_eq!(
        status, "success",
        "the retried job ends terminal: {error:?}"
    );
}

/// A queued batch prints every record from its own stored data and the
/// counters move: `done`/`failed` count, and the batch ends `success` or
/// `failed` — never stuck `queued`/`printing`.
#[tokio::test]
async fn a_queued_batch_prints_every_record_and_the_counters_move() {
    let db = test_db();
    let printer_id = seed_printer(&db, "Desk", &mock_ipp_server(0x0000));
    let template_id = seed_template(&db);

    let batch_id = {
        let guard = db.lock().unwrap();
        let conn = guard.connection();
        conn.execute(
            "INSERT INTO batches (template_id, printer_id, total, mode, status) VALUES (?1, ?2, 3, 'per_record', 'queued')",
            rusqlite::params![template_id, printer_id],
        )
        .unwrap();
        let batch_id = conn.last_insert_rowid();
        for (i, record) in [r#"{"n":1}"#, r#"{"n":2}"#, r#"{"n":3}"#]
            .iter()
            .enumerate()
        {
            conn.execute(
                "INSERT INTO print_jobs (batch_id, record_index, template_id, printer_id, source, status, copies, is_test, data_json)
                 VALUES (?1, ?2, ?3, ?4, 'batch', 'queued', 1, 0, ?5)",
                rusqlite::params![batch_id, i as i64, template_id, printer_id, record],
            )
            .unwrap();
        }
        batch_id
    };

    // Each record's own data is stored on its row (P3: it used to be
    // dropped, leaving nothing to print).
    let stored: Vec<String> = {
        let guard = db.lock().unwrap();
        let mut stmt = guard
            .connection()
            .prepare("SELECT data_json FROM print_jobs WHERE batch_id = ?1 ORDER BY record_index")
            .unwrap();
        let rows = stmt
            .query_map([batch_id], |r| r.get::<_, String>(0))
            .unwrap();
        rows.collect::<Result<Vec<_>, _>>().unwrap()
    };
    assert_eq!(
        stored,
        vec!["{\"n\":1}", "{\"n\":2}", "{\"n\":3}"],
        "every record keeps its own data"
    );

    let worker = Worker::new(db.clone(), PrintQueue::new(), cache_dir());
    let ran = worker.drain(Arc::new(CountingRenderer::default())).await;
    assert_eq!(ran, 3, "every record of the batch was claimed");

    let (status, done, failed) = batch_state(&db, batch_id);
    assert_eq!((status.as_str(), done, failed), ("success", 3, 0));
}

/// A batch whose printer rejects every record ends `failed` with the failed
/// count moved — the "done and failed counters move" part of P3.
#[tokio::test]
async fn a_batch_whose_records_fail_ends_failed() {
    let db = test_db();
    let printer_id = seed_printer(&db, "Desk", &mock_ipp_server(0x0502));
    let template_id = seed_template(&db);

    let batch_id = {
        let guard = db.lock().unwrap();
        let conn = guard.connection();
        conn.execute(
            "INSERT INTO batches (template_id, printer_id, total, mode, status) VALUES (?1, ?2, 2, 'per_record', 'queued')",
            rusqlite::params![template_id, printer_id],
        )
        .unwrap();
        let batch_id = conn.last_insert_rowid();
        for i in 0..2 {
            conn.execute(
                "INSERT INTO print_jobs (batch_id, record_index, template_id, printer_id, source, status, copies, is_test, data_json)
                 VALUES (?1, ?2, ?3, ?4, 'batch', 'queued', 1, 0, ?5)",
                rusqlite::params![batch_id, i as i64, template_id, printer_id, r#"{"n":1}"#],
            )
            .unwrap();
        }
        batch_id
    };

    let worker = Worker::new(db.clone(), PrintQueue::new(), cache_dir());
    worker.drain(Arc::new(CountingRenderer::default())).await;

    let (status, done, failed) = batch_state(&db, batch_id);
    assert_eq!(
        (status.as_str(), done, failed),
        ("failed", 2, 2),
        "failing records move the failed counter and end the batch"
    );
}

/// A cancelled row is skipped: the claim only takes `queued` rows, so
/// cancelling and the worker can never print the same row twice.
#[tokio::test]
async fn cancelled_rows_are_never_printed() {
    let db = test_db();
    let printer_id = seed_printer(&db, "Desk", &mock_ipp_server(0x0000));
    let job_id = queued_rendered_job(&db, printer_id, "<p>label</p>");
    {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .execute(
                "UPDATE print_jobs SET status = 'cancelled' WHERE id = ?1",
                [job_id],
            )
            .unwrap();
    }

    let worker = Worker::new(db.clone(), PrintQueue::new(), cache_dir());
    let renderer = Arc::new(CountingRenderer::default());
    let ran = worker.drain(renderer.clone()).await;

    assert_eq!(ran, 0, "a cancelled row is not claimed");
    assert_eq!(renderer.renders.load(Ordering::SeqCst), 0);
    assert_eq!(job_state(&db, job_id).0, "cancelled");
}

/// A row with nothing to run — no stored HTML, no template — ends `failed`
/// with the reason. The invariant: a queued job always ends terminal.
#[tokio::test]
async fn a_queued_job_with_nothing_to_print_fails() {
    let db = test_db();
    let printer_id = seed_printer(&db, "Desk", &mock_ipp_server(0x0000));
    let job_id = {
        let guard = db.lock().unwrap();
        let g = guard.connection();
        g.execute(
            "INSERT INTO print_jobs (printer_id, source, status, copies, is_test)
             VALUES (?1, 'ui', 'queued', 1, 0)",
            [printer_id],
        )
        .unwrap();
        g.last_insert_rowid()
    };

    let worker = Worker::new(db.clone(), PrintQueue::new(), cache_dir());
    worker.drain(Arc::new(CountingRenderer::default())).await;

    let (status, error, ..) = job_state(&db, job_id);
    assert_eq!(status, "failed");
    assert!(
        error.unwrap_or_default().contains("nothing to print"),
        "the row fails with the reason, not silently"
    );
}

/// Rows a dead process left in `printing` end `failed` at startup instead
/// of hanging forever.
#[tokio::test]
async fn interrupted_printing_rows_fail_on_startup() {
    let db = test_db();
    let printer_id = seed_printer(&db, "Desk", &mock_ipp_server(0x0000));
    let job_id = queued_rendered_job(&db, printer_id, "<p>label</p>");
    {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .execute(
                "UPDATE print_jobs SET status = 'printing' WHERE id = ?1",
                [job_id],
            )
            .unwrap();
    }

    let worker = Worker::new(db.clone(), PrintQueue::new(), cache_dir());
    let recovered = worker.recover_interrupted().expect("recovery runs");
    assert_eq!(recovered, 1);

    let (status, error, ..) = job_state(&db, job_id);
    assert_eq!(status, "failed");
    assert!(error.unwrap_or_default().contains("interrupted"));
}
