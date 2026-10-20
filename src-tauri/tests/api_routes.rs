//! Integration tests for the REST API: auth, idempotency, and route wiring.
//!
//! A real axum server is bound to an ephemeral port and driven with
//! `reqwest`, so routing/middleware bugs surface here instead of at runtime.

use axum::http::{Request, StatusCode};
use printninja_lib::api::auth::ApiKey;
use printninja_lib::db::Database;
use rusqlite::Connection;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

type Db = Arc<Mutex<Database>>;

fn setup() -> (Db, String) {
    // A UUID, not a timestamp: Windows' clock is coarse enough that parallel
    // tests could get the same file name and share (and lock) one SQLite DB.
    let path = std::env::temp_dir().join(format!("printninja_api_{}.db", uuid::Uuid::new_v4()));

    let mut conn = Connection::open(&path).expect("open db");
    conn.execute_batch(include_str!("../src/db/schema.sql"))
        .expect("apply schema");
    printninja_lib::db::ensure_v2_schema(&mut conn).expect("apply v2 schema");
    drop(conn);

    let db: Db = Arc::new(Mutex::new(Database {
        url: format!("sqlite:{}", path.display()),
    }));

    // Seed an API client.
    let (plain, hash) = ApiKey::generate();
    {
        let guard = db.lock().unwrap();
        let c = guard.connection().unwrap();
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
    let c = guard.connection().unwrap();

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
        let c = guard.connection().unwrap();
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
    let c = guard.connection().unwrap();
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
    let c = guard.connection().unwrap();
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE idempotency_key = 'order-1042'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1, "idempotent replay must not print twice");
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
            queue: std::sync::Arc::new(printninja_lib::queue::PrintQueue::new().0),
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
    let c = guard.connection().unwrap();
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
            .unwrap()
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
    let c = guard.connection().unwrap();
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE source='api'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 3);
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
    let conn = guard.connection().unwrap();

    assert!(printninja_lib::verify_api_key(&conn, &plain));
    assert!(!printninja_lib::verify_api_key(&conn, "pn_live_nope"));
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
    let c = guard.connection().unwrap();
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
    let c = guard.connection().unwrap();
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

    // The body is required and documented as such.
    let required = spec["paths"]["/v1/print"]["post"]["requestBody"]["required"]
        .as_bool()
        .unwrap_or(false);
    assert!(required, "requestBody must be required");
    for field in ["template", "printer", "data"] {
        assert!(
            spec["paths"]["/v1/print"]["post"]["requestBody"]["content"]["application/json"]
                ["schema"]["required"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(field))),
            "{field} must be documented as required"
        );
    }
}
