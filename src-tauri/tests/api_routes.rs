//! Integration tests for the REST API: auth, idempotency, and route wiring.
//!
//! A real axum server is bound to an ephemeral port and driven with
//! `reqwest`, so routing/middleware bugs surface here instead of at runtime.

use axum::http::{Request, StatusCode};
use printninja_lib::api::auth::ApiKey;
use printninja_lib::db::Database;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

type Db = Arc<Mutex<Database>>;

fn setup() -> (Db, String) {
    // A UUID, not a timestamp: Windows' clock is coarse enough that parallel
    // tests could get the same file name and share (and lock) one SQLite DB.
    let path = std::env::temp_dir().join(format!("printninja_api_{}.db", uuid::Uuid::new_v4()));

    // `Database::open` is the one schema path: DDL, migrations, WAL, busy
    // timeout — so the test exercises exactly what the app runs.
    let db: Db = Arc::new(Mutex::new(
        Database::open(&format!("sqlite:{}", path.display())).expect("open db"),
    ));

    // Seed an API client.
    let (plain, hash) = ApiKey::generate();
    {
        let guard = db.lock().unwrap();
        let c = guard.connection();
        c.execute(
            "INSERT INTO api_clients (name, key_hash, scopes) VALUES ('t', ?1, 'print,read')",
            [&hash],
        )
        .unwrap();
    }

    (db, plain)
}

fn seed_printers_and_templates(db: &Db) -> (String, String) {
    let guard = db.lock().unwrap();
    let c = guard.connection();

    c.execute(
        "INSERT INTO printers (name, type, address, language) VALUES ('Desk','ipp','1.2.3.4','pdf')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation)
         VALUES ('Receipt',120,200,'portrait')",
        [],
    )
    .unwrap();
    let tid = c.last_insert_rowid();
    let vid = c
        .execute(
            "INSERT INTO template_versions (template_id, version_no, html, css, created_by)
         VALUES (?1, 1, '<p>hi</p>', '', 'manual')",
            [tid],
        )
        .unwrap();
    // The real `create_template` sets this; without it the template has
    // versions on disk but nothing "current" to render.
    c.execute(
        "UPDATE templates SET current_version_id = ?1 WHERE id = ?2",
        rusqlite::params![vid, tid],
    )
    .unwrap();
    drop(guard);
    ("Desk".to_string(), "Receipt".to_string())
}

// ───────────────────────────────────────────────────────────────
// auth
// ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn health_is_open_without_a_key() {
    let (db, _key) = setup();
    let app = router(&db);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/health")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn health_reports_the_database() {
    let (db, _key) = setup();
    let app = router(&db);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/health")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body: serde_json::Value = {
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    };
    assert_eq!(body["status"], "ok");
    assert_eq!(body["db"], "up");
}

#[tokio::test]
async fn printers_requires_authorization() {
    let (db, _key) = setup();
    let app = router(&db);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/printers")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn wrong_key_is_rejected() {
    let (db, _key) = setup();
    let app = router(&db);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/printers")
                .header("authorization", "Bearer pn_live_definitely_wrong")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn valid_key_is_accepted() {
    let (db, key) = setup();
    seed_printers_and_templates(&db);
    let app = router(&db);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/printers")
                .header("authorization", format!("Bearer {}", key))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::OK);
}

// ───────────────────────────────────────────────────────────────
// route wiring (regression for the shadowed DELETE route)
// ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn jobs_id_supports_both_get_and_delete() {
    let (db, key) = setup();

    {
        let guard = db.lock().unwrap();
        let c = guard.connection();
        c.execute(
            "INSERT INTO print_jobs (source, status, copies, is_test)
             VALUES ('api','queued',1,0)",
            [],
        )
        .unwrap();
    }

    // GET /v1/jobs/1 must work (previously shadowed by the DELETE route).
    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/jobs/1")
                .header("authorization", format!("Bearer {}", key))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::OK,
        "GET /v1/jobs/{{id}} must not 404/405"
    );

    // DELETE /v1/jobs/1 must cancel the queued job.
    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/v1/jobs/1")
                .header("authorization", format!("Bearer {}", key))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::NO_CONTENT,
        "DELETE must reach its handler"
    );

    let guard = db.lock().unwrap();
    let c = guard.connection();
    let status: String = c
        .query_row("SELECT status FROM print_jobs WHERE id = 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(status, "cancelled");
}

// ───────────────────────────────────────────────────────────────
// idempotency
// ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn duplicate_idempotency_key_does_not_create_a_second_job() {
    let (db, key) = setup();
    seed_printers_and_templates(&db);

    let body = serde_json::json!({
        "template": "Receipt",
        "printer": "Desk",
        "data": {"order": 1}
    })
    .to_string();

    // First request creates the job.
    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("authorization", format!("Bearer {}", key))
                .header("content-type", "application/json")
                .header("idempotency-key", "order-1042")
                .body(axum::body::Body::from(body.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    // The first request runs the real pipeline. On a non-Windows CI host the
    // print itself fails (no spooler), so assert only that it was *not*
    // silently accepted as "queued" — and, crucially, that it still wrote a
    // history row carrying the idempotency key, which is what makes the
    // replay detectable at all.
    assert_ne!(res.status(), StatusCode::ACCEPTED);

    // Replay must be rejected.
    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("authorization", format!("Bearer {}", key))
                .header("content-type", "application/json")
                .header("idempotency-key", "order-1042")
                .body(axum::body::Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK, "replay returns 200 duplicate");

    let guard = db.lock().unwrap();
    let c = guard.connection();
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE idempotency_key = 'order-1042'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1, "idempotent replay must not print twice");
}

/// P12: two simultaneous requests with one idempotency key print once.
/// Both can pass the `check_auth` fast path before either inserts; the
/// unique index on `idempotency_key` is what still records one job — the
/// loser answers `200 duplicate` instead of running the pipeline again.
#[tokio::test]
async fn two_simultaneous_requests_with_one_key_print_once() {
    let (db, key) = setup();
    seed_printers_and_templates(&db);

    let body = serde_json::json!({
        "template": "Receipt",
        "printer": "Desk",
        "data": {"order": 2}
    })
    .to_string();

    let send = |app: axum::Router, body: String, key: String| async move {
        app.oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("authorization", format!("Bearer {}", key))
                .header("content-type", "application/json")
                .header("idempotency-key", "race-1")
                .body(axum::body::Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap()
    };

    // Interleaved on one runtime, so each request gets past the replay
    // fast-path check before the other's insert lands, worst case.
    let (res_a, res_b) = tokio::join!(
        send(router(&db), body.clone(), key.clone()),
        send(router(&db), body, key),
    );

    // One of the two ran the pipeline (its status is the pipeline's own —
    // success or failure), and the other is the 200 duplicate.
    let duplicates = [res_a.status(), res_b.status()]
        .iter()
        .filter(|s| **s == StatusCode::OK)
        .count();
    assert!(
        duplicates >= 1,
        "the loser must answer 200 duplicate, got {:?} and {:?}",
        res_a.status(),
        res_b.status()
    );

    let guard = db.lock().unwrap();
    let c = guard.connection();
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE idempotency_key = 'race-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        n,
        1,
        "one key must record exactly one job (statuses {:?}, {:?})",
        res_a.status(),
        res_b.status()
    );
}

/// P12: `callback_url` is accepted-and-ignored nowhere — there is no
/// callback runner, so a caller that relied on one would never learn the
/// outcome. Refused with 400 before any DB work: a request the server will
/// not honour creates no job.
#[tokio::test]
async fn callback_url_is_refused_with_400_before_anything_runs() {
    let (db, key) = setup();
    seed_printers_and_templates(&db);

    let body = serde_json::json!({
        "template": "Receipt",
        "printer": "Desk",
        "callback_url": "https://example.com/done"
    })
    .to_string();

    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("authorization", format!("Bearer {}", key))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::BAD_REQUEST,
        "callback_url must be refused, not silently dropped"
    );

    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let msg = String::from_utf8_lossy(&bytes);
    assert!(
        msg.contains("callback_url"),
        "the refusal names the field: {msg}"
    );

    let guard = db.lock().unwrap();
    let n: i64 = guard
        .connection()
        .query_row("SELECT COUNT(*) FROM print_jobs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0, "nothing runs for a refused request");
}

/// P12's `data` half: the handler treats `data` as optional, so a print
/// without it must reach the pipeline — which records its row (P15) —
/// instead of dying as a validation error.
#[tokio::test]
async fn a_print_without_data_is_not_a_validation_error() {
    let (db, key) = setup();
    seed_printers_and_templates(&db);

    let body = serde_json::json!({
        "template": "Receipt",
        "printer": "Desk"
    })
    .to_string();

    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("authorization", format!("Bearer {}", key))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_ne!(
        res.status(),
        StatusCode::BAD_REQUEST,
        "missing `data` is not a validation error"
    );

    // Past validation means the pipeline ran and recorded its row.
    let guard = db.lock().unwrap();
    let n: i64 = guard
        .connection()
        .query_row("SELECT COUNT(*) FROM print_jobs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1, "the job was attempted, not rejected");
}

/// Build the router the way the real app does.
///
/// The state carries a print queue and a cache dir so `POST /v1/print` runs
/// the real pipeline instead of only inserting a "queued" row.
fn router(db: &Db) -> axum::Router {
    let cache = std::env::temp_dir().join(format!("printninja_api_cache_{}", uuid::Uuid::new_v4()));
    printninja_lib::api::routes::router_with_state(
        printninja_lib::api::routes::ApiState {
            db: db.clone(),
            queue: std::sync::Arc::new(printninja_lib::queue::PrintQueue::new()),
            cache_dir: cache,
        },
        false,
    )
}

// ───────────────────────────────────────────────────────────────
// endpoint behaviour
// ───────────────────────────────────────────────────────────────

/// Regression for #18: `POST /v1/print` used to insert a row with
/// `status = 'queued'` and return `202 Accepted` **without printing
/// anything at all** — no render, no transport, no queue. It now runs the
/// same pipeline as the desktop UI.
///
/// On a non-Windows CI host there is no spooler, so the print itself fails —
/// which is exactly the point: the caller gets the real outcome, not a
/// cheerful "queued" and no paper.
#[tokio::test]
async fn print_runs_the_real_pipeline_instead_of_lying_queued() {
    let (db, key) = setup();
    seed_printers_and_templates(&db);

    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("authorization", format!("Bearer {}", key))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({
                        "template": "Receipt",
                        "printer": "Desk",
                        "data": {"order": {"id": 7}}
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    // Not 202/"queued" any more.
    assert_ne!(res.status(), StatusCode::ACCEPTED);

    // A history row is written either way, tagged as coming from the API.
    let guard = db.lock().unwrap();
    let c = guard.connection();
    let source: String = c
        .query_row("SELECT source FROM print_jobs LIMIT 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(source, "api");
}

/// The endpoint must reject a request it cannot actually render rather than
/// accepting it and doing nothing.
#[tokio::test]
async fn print_requires_a_template() {
    let (db, key) = setup();
    seed_printers_and_templates(&db);

    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("authorization", format!("Bearer {}", key))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({ "printer": "Desk", "data": {} }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

/// A template whose `current_version_id` is unset has nothing to render.
/// That used to be reported as a cheerful "queued"; it must be a 404.
#[tokio::test]
async fn print_rejects_a_template_with_no_current_version() {
    let (db, key) = setup();
    seed_printers_and_templates(&db);
    {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .execute("UPDATE templates SET current_version_id = NULL", [])
            .unwrap();
    }

    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("authorization", format!("Bearer {}", key))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({
                        "template": "Receipt",
                        "printer": "Desk",
                        "data": {}
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn print_rejects_unknown_printer() {
    let (db, key) = setup();
    seed_printers_and_templates(&db);

    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("authorization", format!("Bearer {}", key))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({
                        "template": "Receipt",
                        "printer": "Does Not Exist",
                        "data": {}
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn batch_print_creates_one_job_per_record() {
    let (db, key) = setup();
    seed_printers_and_templates(&db);

    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print/batch")
                .header("authorization", format!("Bearer {}", key))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({
                        "template": "Receipt",
                        "printer": "Desk",
                        "mode": "per_record",
                        "data": [{"n":1},{"n":2},{"n":3}]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::ACCEPTED);

    let guard = db.lock().unwrap();
    let c = guard.connection();
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE source='api'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 3);

    // Each record's own payload is stored on its row — that is what the
    // worker renders (P3). It used to be dropped, so queued rows had
    // nothing to print.
    let stored = {
        let mut stmt = c
            .prepare("SELECT data_json FROM print_jobs WHERE source='api' ORDER BY record_index")
            .unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        rows.collect::<Result<Vec<_>, _>>().unwrap()
    };
    assert_eq!(stored, vec!["{\"n\":1}", "{\"n\":2}", "{\"n\":3}"]);
}

/// An empty batch queues nothing to print, and the same 5,000-record cap
/// the IPC batch command enforces applies to the API (both return 400,
/// not a cheerful 202 with rows nobody will ever run).
#[tokio::test]
async fn batch_print_validates_record_count() {
    let (db, key) = setup();
    seed_printers_and_templates(&db);

    for (label, data) in [
        ("empty", serde_json::json!([])),
        (
            "oversized",
            serde_json::json!((0..=5000)
                .map(|i| serde_json::json!({ "n": i }))
                .collect::<Vec<_>>()),
        ),
    ] {
        let app = router(&db);
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/print/batch")
                    .header("authorization", format!("Bearer {}", key))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "template": "Receipt",
                            "printer": "Desk",
                            "mode": "per_record",
                            "data": data
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            res.status(),
            StatusCode::BAD_REQUEST,
            "{label} batch rejected"
        );
    }

    let guard = db.lock().unwrap();
    let n: i64 = guard
        .connection()
        .query_row("SELECT COUNT(*) FROM batches", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0, "a rejected batch must insert nothing at all");
}

/// Retry re-queues only terminal rows: a `queued` or running job must not
/// be re-queued (it would print twice), and an unknown id stays a 404 (P3).
#[tokio::test]
async fn retry_rejects_non_terminal_jobs_and_still_404s_unknown_ones() {
    let (db, key) = setup();
    seed_printers_and_templates(&db);

    let queued_id: i64 = {
        let guard = db.lock().unwrap();
        let conn = guard.connection();
        conn.execute(
            "INSERT INTO print_jobs (source, status, copies, is_test)
             VALUES ('api', 'queued', 1, 0)",
            [],
        )
        .unwrap();
        conn.last_insert_rowid()
    };

    let retry = |id: i64, key: String, db: Db| async move {
        let app = router(&db);
        app.oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/v1/jobs/{id}/retry"))
                .header("authorization", format!("Bearer {}", key))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
    };

    let res = retry(queued_id, key.clone(), db.clone()).await;
    assert_eq!(
        res.status(),
        StatusCode::BAD_REQUEST,
        "a queued job is not retryable"
    );

    let res = retry(424242, key.clone(), db.clone()).await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND, "unknown id stays 404");

    // Once it is failed, retry re-queues it — and the worker owns it then.
    {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .execute(
                "UPDATE print_jobs SET status='failed', error='offline' WHERE id=?1",
                [queued_id],
            )
            .unwrap();
    }
    let res = retry(queued_id, key, db.clone()).await;
    assert_eq!(res.status(), StatusCode::OK, "failed job re-queues");
}

#[tokio::test]
async fn openapi_documents_bearer_auth() {
    let (db, _key) = setup();
    let app = router(&db);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/openapi.json")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        res.status(),
        StatusCode::UNAUTHORIZED,
        "openapi also requires a key"
    );
}

#[tokio::test]
async fn verify_stored_key_matches_hashed_value() {
    let (db, plain) = setup();
    let guard = db.lock().unwrap();
    let conn = guard.connection();

    assert!(printninja_lib::verify_api_key(conn, &plain));
    assert!(!printninja_lib::verify_api_key(conn, "pn_live_nope"));

    // The richer API hands the middleware the row it enforces.
    let key = printninja_lib::commands::api::verify_stored_key(conn, &plain)
        .expect("the valid key must verify");
    assert_eq!(
        key.scopes,
        vec!["print".to_string(), "read".to_string()],
        "the app's default key holds print,read"
    );
    assert!(key.allowed_ips.is_empty(), "and no IP allowlist");
}
/// Regression for #18: nothing ever wrote `print_jobs.idempotency_key`, so the
/// replay guard in `check_auth` — which looks for an existing row with that
/// key — could never fire. A retried request printed twice.
#[tokio::test]
async fn the_idempotency_key_is_persisted_with_the_job() {
    let (db, key) = setup();
    seed_printers_and_templates(&db);

    let app = router(&db);
    let _ = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("authorization", format!("Bearer {}", key))
                .header("content-type", "application/json")
                .header("idempotency-key", "order-7777")
                .body(axum::body::Body::from(
                    serde_json::json!({
                        "template": "Receipt",
                        "printer": "Desk",
                        "data": {}
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    let guard = db.lock().unwrap();
    let c = guard.connection();
    let stored: Option<String> = c
        .query_row(
            "SELECT idempotency_key FROM print_jobs ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        stored.as_deref(),
        Some("order-7777"),
        "the replay guard depends on this column being written"
    );
}

/// A job with no `Idempotency-Key` header must not invent one — otherwise
/// every keyless request would collide with every other keyless request.
#[tokio::test]
async fn requests_without_a_key_do_not_collide() {
    let (db, key) = setup();
    seed_printers_and_templates(&db);

    for _ in 0..2 {
        let app = router(&db);
        let _ = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/print")
                    .header("authorization", format!("Bearer {}", key))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "template": "Receipt",
                            "printer": "Desk",
                            "data": {}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
    }

    let guard = db.lock().unwrap();
    let c = guard.connection();
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE idempotency_key IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 2, "keyless requests must all be recorded");
}

/// The OpenAPI document is the API's contract, and `POST /v1/print` was
/// documented as creating a queued job. It now renders and prints, so the
/// documented status codes must match what the handler really returns.
#[tokio::test]
async fn openapi_documents_the_print_response_codes() {
    let (db, _key) = setup();
    let app = router(&db);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/openapi.json")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    let (db, key) = setup();
    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/openapi.json")
                .header("authorization", format!("Bearer {}", key))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let spec: serde_json::Value = serde_json::from_slice(&body).unwrap();

    let responses = spec["paths"]["/v1/print"]["post"]["responses"]
        .as_object()
        .expect("documented responses");
    for code in ["200", "400", "401", "404", "500"] {
        assert!(responses.contains_key(code), "missing documented {code}");
    }

    // 202 is deliberately absent: the endpoint no longer lies about queueing.
    assert!(
        !responses.contains_key("202"),
        "must not document the old fake 'queued' 202"
    );

    // The body is required; only `template` and `printer` are. The handler
    // treats `data` as optional, so the contract must not claim otherwise
    // (P12: "openapi.rs says data is required; the code treats it as
    // optional").
    let required = spec["paths"]["/v1/print"]["post"]["requestBody"]["required"]
        .as_bool()
        .unwrap_or(false);
    assert!(required, "requestBody must be required");
    let fields: Vec<&str> = spec["paths"]["/v1/print"]["post"]["requestBody"]["content"]
        ["application/json"]["schema"]["required"]
        .as_array()
        .expect("`required` must be an array")
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    assert!(
        fields.contains(&"template") && fields.contains(&"printer"),
        "template and printer are required: {fields:?}"
    );
    assert!(
        !fields.contains(&"data"),
        "`data` is optional in the handler, so it must not be documented as required: {fields:?}"
    );
}

/// P12: the hand-written document must describe what the router really
/// returns — batch queues rows for the worker and answers `202`, cancel
/// answers `204` with no body, and the jobs endpoints answer `404`/`400`
/// for missing or non-terminal jobs.
#[tokio::test]
async fn the_openapi_document_matches_the_router() {
    let (db, key) = setup();
    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/openapi.json")
                .header("authorization", format!("Bearer {}", key))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let spec: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let paths = &spec["paths"];
    let codes = |path: &str, method: &str| -> Vec<String> {
        paths[path][method]["responses"]
            .as_object()
            .unwrap_or_else(|| panic!("documented responses for {method} {path}"))
            .keys()
            .cloned()
            .collect()
    };

    // Batch really queues for the worker: 202, not a "created" 200.
    let batch = codes("/v1/print/batch", "post");
    for want in ["202", "400", "401", "404"] {
        assert!(
            batch.contains(&want.to_string()),
            "batch must document {want}: {batch:?}"
        );
    }
    assert!(
        !batch.iter().any(|c| c == "200"),
        "batch answers 202, not 200: {batch:?}"
    );

    // Cancel answers 204 with no body.
    let delete = codes("/v1/jobs/{id}", "delete");
    for want in ["204", "400", "401"] {
        assert!(
            delete.contains(&want.to_string()),
            "cancel must document {want}: {delete:?}"
        );
    }
    assert!(
        !delete.iter().any(|c| c == "200"),
        "cancel answers 204, not 200: {delete:?}"
    );

    // Get reports a missing job with 404; retry with 404 and a refused
    // re-queue with 400.
    let get = codes("/v1/jobs/{id}", "get");
    for want in ["200", "401", "404"] {
        assert!(
            get.contains(&want.to_string()),
            "get must document {want}: {get:?}"
        );
    }
    let retry = codes("/v1/jobs/{id}/retry", "post");
    for want in ["200", "400", "401", "404"] {
        assert!(
            retry.contains(&want.to_string()),
            "retry must document {want}: {retry:?}"
        );
    }

    // The document describes its own endpoint.
    let spec_ep = codes("/v1/openapi.json", "get");
    assert!(
        spec_ep.iter().any(|c| c == "200"),
        "the spec endpoint must document itself: {spec_ep:?}"
    );

    // Every keyed endpoint documents both refusal modes: no or wrong key
    // (401) and a key refused by scope or IP allowlist (403). Health is
    // open and documents neither.
    for (path, operations) in paths.as_object().expect("paths object") {
        for (method, operation) in operations.as_object().expect("operations") {
            if path == "/v1/health" {
                continue;
            }
            let documented: Vec<&String> = operation["responses"]
                .as_object()
                .unwrap_or_else(|| panic!("responses of {method} {path}"))
                .keys()
                .collect();
            assert!(
                documented.iter().any(|c| *c == "401"),
                "{method} {path} must document 401: {documented:?}"
            );
            assert!(
                documented.iter().any(|c| *c == "403"),
                "{method} {path} must document 403: {documented:?}"
            );
        }
    }
}

// ───────────────────────────────────────────────────────────────
// scopes, allowed_ips, last_used_at (P12: stored, now enforced)
// ───────────────────────────────────────────────────────────────

/// The default key holds `print,read`; a hand-set key holding only `print`
/// may print but not read, and a key holding only `read` may read but not
/// print — 403, never a silent success. The replay fast path must not
/// outrank that: a used `Idempotency-Key` presented with the wrong scope
/// gets 403, not the duplicate's 200.
#[tokio::test]
async fn scopes_are_enforced_and_outrank_the_replay_response() {
    let (db, admin_key) = setup();
    seed_printers_and_templates(&db);

    let (print_only_plain, print_only_hash) = ApiKey::generate();
    let (read_only_plain, read_only_hash) = ApiKey::generate();
    {
        let guard = db.lock().unwrap();
        let c = guard.connection();
        c.execute(
            "INSERT INTO api_clients (name, key_hash, scopes) VALUES ('print-only', ?1, 'print')",
            [&print_only_hash],
        )
        .unwrap();
        c.execute(
            "INSERT INTO api_clients (name, key_hash, scopes) VALUES ('read-only', ?1, 'read')",
            [&read_only_hash],
        )
        .unwrap();
    }

    // A print-only key cannot read …
    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/jobs")
                .header("authorization", format!("Bearer {print_only_plain}"))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::FORBIDDEN,
        "a key without scope 'read' must not list jobs"
    );

    // … but may print: the pipeline runs and reports its own outcome —
    // never an auth refusal.
    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("authorization", format!("Bearer {print_only_plain}"))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({"template": "Receipt", "printer": "Desk"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        res.status() != StatusCode::FORBIDDEN && res.status() != StatusCode::UNAUTHORIZED,
        "a key with scope 'print' must not be refused: {}",
        res.status()
    );

    // Consume an idempotency key with the full-scope default key …
    let app = router(&db);
    let _ = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("authorization", format!("Bearer {admin_key}"))
                .header("content-type", "application/json")
                .header("idempotency-key", "scope-order")
                .body(axum::body::Body::from(
                    serde_json::json!({"template": "Receipt", "printer": "Desk"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    // … then present it with a read-only key on a printing route: the
    // scope decides, not the replay fast path.
    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("authorization", format!("Bearer {read_only_plain}"))
                .header("content-type", "application/json")
                .header("idempotency-key", "scope-order")
                .body(axum::body::Body::from(
                    serde_json::json!({"template": "Receipt", "printer": "Desk"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::FORBIDDEN,
        "authentication and scope must be judged before the replay response"
    );
}

/// A non-empty `allowed_ips` is enforced against the peer address, and
/// fails closed when the peer is unknown. A key without an allowlist is
/// peer-independent — which is what every key created by the app is.
#[tokio::test]
async fn an_ip_allowlist_is_enforced_and_fails_closed() {
    let (db, default_plain) = setup();

    let (plain, hash) = ApiKey::generate();
    {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .execute(
                "INSERT INTO api_clients (name, key_hash, scopes, allowed_ips)
                 VALUES ('lan', ?1, 'print,read', '203.0.113.9')",
                [&hash],
            )
            .unwrap();
    }

    let request = |plain: &str, peer: Option<std::net::SocketAddr>| {
        let mut req = Request::builder()
            .uri("/v1/printers")
            .header("authorization", format!("Bearer {plain}"))
            .body(axum::body::Body::empty())
            .unwrap();
        if let Some(addr) = peer {
            req.extensions_mut()
                .insert(axum::extract::ConnectInfo(addr));
        }
        router(&db).oneshot(req)
    };

    // The allowlist refuses when the peer is unknown — a listener that
    // lost ConnectInfo must not become a bypass.
    let res = request(&plain, None).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN, "fail closed");

    // The listed peer is allowed …
    let listed: std::net::SocketAddr = "203.0.113.9:40000".parse().unwrap();
    let res = request(&plain, Some(listed)).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // … and every other peer is refused.
    let other: std::net::SocketAddr = "198.51.100.7:40000".parse().unwrap();
    let res = request(&plain, Some(other)).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // A key without an allowlist stays peer-independent.
    let res = request(&default_plain, Some(other)).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK, "no allowlist, no refusal");
}

/// `last_used_at` was stored and never written. It now records every
/// request the key was allowed to make — and nothing for a refusal.
#[tokio::test]
async fn last_used_at_is_stamped_only_when_the_request_is_allowed() {
    let (db, key) = setup();

    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/printers")
                .header("authorization", format!("Bearer {key}"))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let stamped: Option<String> = {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .query_row(
                // setup() seeds the default key under the name 't'.
                "SELECT last_used_at FROM api_clients WHERE name = 't'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    };
    assert!(
        stamped.as_deref().is_some_and(|s| !s.is_empty()),
        "an allowed request must stamp last_used_at: {stamped:?}"
    );

    // A refused request stamps nothing: leave a sentinel, get the 403,
    // and the sentinel must still be there.
    let (plain, hash) = ApiKey::generate();
    {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .execute(
                "INSERT INTO api_clients (name, key_hash, scopes, last_used_at)
                 VALUES ('read-only', ?1, 'read', 'sentinel')",
                [&hash],
            )
            .unwrap();
    }
    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/printers")
                .header("authorization", format!("Bearer {plain}"))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK, "read-only may read");

    // Leave a sentinel between the allowed GET and the refused POST.
    {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .execute(
                "UPDATE api_clients SET last_used_at = 'sentinel' WHERE name = 'read-only'",
                [],
            )
            .unwrap();
    }

    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("authorization", format!("Bearer {plain}"))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({"template": "Receipt", "printer": "Desk"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::FORBIDDEN,
        "read-only may not print"
    );

    let stamped: Option<String> = {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .query_row(
                "SELECT last_used_at FROM api_clients WHERE name = 'read-only'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    };
    assert_eq!(
        stamped.as_deref(),
        Some("sentinel"),
        "a 403 must not stamp last_used_at"
    );
}
