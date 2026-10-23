use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::db::DbState;
use crate::error::AppError;

/// Everything a route handler needs.
///
/// The queue and the app handle are here, not just the DB, because
/// `POST /v1/print` used to insert a row with `status = 'queued'`, return
/// `202 Accepted`, and never print anything at all. Now it runs the same
/// pipeline as the desktop UI — including the per-printer queue permit — so
/// an API caller and a UI user cannot interleave bytes on one thermal head.
#[derive(Clone)]
pub struct ApiState {
    pub db: DbState,
    pub queue: std::sync::Arc<crate::queue::PrintQueue>,
    /// Where the PDF renderer writes intermediate files. A plain path, not an
    /// `AppHandle`, so the router can be built in tests without standing up a
    /// Tauri app.
    pub cache_dir: std::path::PathBuf,
}

/// Build a router bound to the app's database state.
///
/// NOTE: `/v1/jobs/{id}` is registered ONCE with `get(..).delete(..)`.
/// Registering the same path twice makes axum shadow the first method,
/// silently dropping GET or DELETE.
pub fn router_with_state(state: ApiState, lan_access: bool) -> Router {
    let auth_ctx = AuthCtx {
        db: state.db.clone(),
    };
    let mut cors = tower_http::cors::CorsLayer::new()
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any);

    if lan_access {
        // Operator opted into LAN access: allow browser origins.
        cors = cors.allow_origin(tower_http::cors::Any);
    }

    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/printers", get(list_printers))
        .route("/v1/templates", get(list_templates))
        .route("/v1/print", post(print_job))
        .route("/v1/print/batch", post(batch_print))
        .route("/v1/jobs", get(list_jobs))
        .route("/v1/jobs/{id}", get(get_job).delete(cancel_job))
        .route("/v1/jobs/{id}/retry", post(retry_job))
        .route("/v1/metrics", get(metrics))
        .route("/v1/metrics/prometheus", get(metrics_prometheus))
        .route("/v1/openapi.json", get(openapi))
        .with_state(state.clone())
        // Per-request spans (method, path, status, latency): the only way
        // to join a slow print across middleware and handler in the logs.
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .layer(middleware::from_fn(
            move |req: axum::extract::Request, next: Next| {
                let auth = auth_ctx.clone();
                async move { auth_middleware_inner(auth, req, next).await }
            },
        ))
        .layer(cors)
}

/// Reject unauthenticated requests before they reach a handler.
///
/// The DB state is passed in explicitly (via a closure) because `State` is
/// not available inside middleware request extensions.
async fn auth_middleware_inner(
    auth: AuthCtx,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let headers = request.headers().clone();
    // Health is intentionally open so probes work without a key.
    if request.uri().path() == "/v1/health" {
        return next.run(request).await;
    }

    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.trim().to_string());

    let Some(token) = token else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing Authorization: Bearer <key>" })),
        )
            .into_response();
    };

    // All DB access happens in a sync helper so the MutexGuard is never
    // held across an await point.

    // GET reads; every other method changes what gets printed — a print,
    // a batch, a re-queue or a cancel — so it needs the `print` scope.
    let required_scope = if request.method() == axum::http::Method::GET {
        "read"
    } else {
        "print"
    };
    // The peer address is inserted by the serve call's
    // `into_make_service_with_connect_info`. Absent means the listener
    // lost it — the allowlist treats that as a refusal, never a pass.
    let peer = request
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|c| c.0);

    let decision = check_auth(
        &auth,
        &token,
        required_scope,
        peer,
        headers.get("idempotency-key"),
    );

    match decision {
        AuthDecision::Allow => next.run(request).await,
        AuthDecision::Duplicate(job_id) => (
            StatusCode::OK,
            Json(json!({
                "status": "duplicate",
                "message": "idempotency key already used; job not created",
                "job_id": job_id.to_string()
            })),
        )
            .into_response(),
        AuthDecision::Forbidden(reason) => {
            (StatusCode::FORBIDDEN, Json(json!({ "error": reason }))).into_response()
        }
        AuthDecision::Unauthorized => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "invalid API key" })),
        )
            .into_response(),
        AuthDecision::Unavailable => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "database unavailable" })),
        )
            .into_response(),
    }
}

/// Outcome of the auth check.
enum AuthDecision {
    Allow,
    /// Key already taken; carries the job that owns it.
    Duplicate(i64),
    /// The key verified but is refused here: wrong scope for this route,
    /// or its IP allowlist does not include the peer.
    Forbidden(String),
    Unauthorized,
    Unavailable,
}

/// Synchronous auth + enforcement. Keeping this non-async guarantees
/// the DB mutex is released before the handler future is awaited.
///
/// The order is the security: the key verifies first, then its IP
/// allowlist, then the scope for this route, and only then the idempotency
/// replay fast path — an unauthenticated or under-scoped request must
/// never be answered with the duplicate's 200, which would leak that a
/// key exists and is in use.
fn check_auth(
    auth: &AuthCtx,
    token: &str,
    required_scope: &str,
    peer: Option<std::net::SocketAddr>,
    idempotency: Option<&axum::http::HeaderValue>,
) -> AuthDecision {
    let Ok(guard) = auth.db.lock() else {
        return AuthDecision::Unavailable;
    };
    let conn = guard.connection();

    let Some(key) = crate::commands::api::verify_stored_key(conn, token) else {
        return AuthDecision::Unauthorized;
    };

    // `allowed_ips` is an allowlist when configured (comma list or JSON
    // array of exact peer-IP strings, e.g. `203.0.113.9`). Empty — which
    // is every key the app creates — means no restriction.
    if !key.allowed_ips.is_empty() {
        match peer {
            Some(addr)
                if key
                    .allowed_ips
                    .iter()
                    .any(|ip| ip == &addr.ip().to_string()) => {}
            Some(addr) => {
                return AuthDecision::Forbidden(format!("key is not allowed from {}", addr.ip()))
            }
            None => {
                return AuthDecision::Forbidden(
                    "peer address unknown; this key's IP allowlist applies".into(),
                )
            }
        }
    }

    // The default key holds `print,read`; a hand-set key may hold either.
    if !key.check_scope(required_scope) {
        return AuthDecision::Forbidden(format!("key lacks scope '{required_scope}'"));
    }

    // Idempotency replay must not print twice (PLANNING.md 7.1). A fast
    // path only — the atomic reservation is the unique index on
    // `idempotency_key` hit at begin_job (P12).
    if let Some(key) = idempotency.and_then(|v| v.to_str().ok()) {
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM print_jobs WHERE idempotency_key = ?1",
                [key],
                |r| r.get(0),
            )
            .ok();
        if let Some(id) = existing {
            return AuthDecision::Duplicate(id);
        }
    }

    // The key authenticated an allowed request: record the use (P12).
    let _ = conn.execute(
        "UPDATE api_clients SET last_used_at = datetime('now') WHERE id = ?1",
        [key.id],
    );

    AuthDecision::Allow
}

/// State threaded into the auth middleware.
#[derive(Clone)]
pub struct AuthCtx {
    pub db: DbState,
}

use axum::response::IntoResponse;

// ── Handlers ────────────────────────────────────────────────────────────────

/// Liveness plus the dependencies a print needs: the database answers
/// and the queue lock is acquirable. A wedged DB (or a poisoned lock)
/// reports degraded instead of a lying "ok".
async fn health(State(state): State<ApiState>) -> Json<Value> {
    let db_ok = state
        .db
        .lock()
        .ok()
        .and_then(|guard| {
            guard
                .connection()
                .query_row("SELECT 1", [], |_| Ok(()))
                .ok()
        })
        .is_some();
    Json(json!({
        "status": if db_ok { "ok" } else { "degraded" },
        "version": env!("CARGO_PKG_VERSION"),
        "app": "PrintNinja",
        "db": if db_ok { "up" } else { "down" },
    }))
}

async fn list_printers(State(state): State<ApiState>) -> Result<Json<Value>, ApiRejection> {
    let db = state.db;
    let guard = db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection();

    let mut stmt = conn
        .prepare("SELECT id, name, type, address, language FROM printers ORDER BY name")
        .map_err(ApiRejection::from)?;

    let printers: Vec<Value> = stmt
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "name": row.get::<_, String>(1)?,
                "type": row.get::<_, String>(2)?,
                "address": row.get::<_, String>(3)?,
                "language": row.get::<_, String>(4)?,
            }))
        })
        .map_err(ApiRejection::from)?
        .filter_map(Result::ok)
        .collect();

    let count = printers.len();
    Ok(Json(json!({ "printers": printers, "count": count })))
}

async fn list_templates(State(state): State<ApiState>) -> Result<Json<Value>, ApiRejection> {
    let db = state.db;
    let guard = db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection();

    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.name, t.page_w_mm, t.page_h_mm, t.orientation
             FROM templates t WHERE t.sync_state <> 'deleted_pending' ORDER BY t.name",
        )
        .map_err(ApiRejection::from)?;

    let templates: Vec<Value> = stmt
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "name": row.get::<_, String>(1)?,
                "page_w_mm": row.get::<_, i64>(2)?,
                "page_h_mm": row.get::<_, i64>(3)?,
                "orientation": row.get::<_, String>(4)?,
            }))
        })
        .map_err(ApiRejection::from)?
        .filter_map(Result::ok)
        .collect();

    let count = templates.len();
    Ok(Json(json!({ "templates": templates, "count": count })))
}

#[derive(Deserialize)]
struct PrintJobRequest {
    template: Option<String>,
    printer: String,
    data: Option<Value>,
    data_url: Option<String>,
    settings: Option<Value>,
    test: Option<bool>,
    /// Refused with 400 in `print_job` — never silently accepted (P12).
    callback_url: Option<String>,
    /// Body-level key, currently unread: the API takes the key from the
    /// `Idempotency-Key` header. Kept for wire compatibility.
    #[allow(dead_code)]
    idempotency_key: Option<String>,
}

async fn print_job(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(req): Json<PrintJobRequest>,
) -> Result<(StatusCode, Json<Value>), ApiRejection> {
    let db = state.db.clone();
    let idempotency_key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // `callback_url` was accepted and ignored (P12): there is no callback
    // runner, so a caller that relied on one would never learn the outcome.
    // Refused before any DB work — a request the server will not honour
    // creates no job.
    if let Some(callback) = &req.callback_url {
        return Err(ApiRejection::BadRequest(format!(
            "`callback_url` is not supported (got `{callback}`); \
             poll `GET /v1/jobs/{{id}}` for the outcome"
        )));
    }

    let settings = req.settings.unwrap_or_else(|| json!({}));
    let copies = settings
        .get("copies")
        .and_then(|c| c.as_u64())
        .unwrap_or(1)
        .max(1) as u32;

    // Everything that touches the DB happens in its own scope so the
    // `MutexGuard` is definitely released before the print. Holding it across
    // a network round-trip to a thermal printer would stall every other
    // command, and the pipeline takes the lock again for its history write.
    let template_id = {
        let guard = db.lock().map_err(ApiRejection::from)?;
        let conn = guard.connection();

        let template_id: Option<i64> = match &req.template {
            Some(name) if !name.is_empty() => Some(
                conn.query_row(
                    "SELECT id FROM templates WHERE name = ?1 COLLATE NOCASE AND sync_state <> 'deleted_pending'",
                    [name],
                    |r| r.get(0),
                )
                .map_err(|_| ApiRejection::NotFound(format!("Template '{}' not found", name)))?,
            ),
            _ => None,
        };

        // A template is required: there is no HTML body in an API request,
        // so without one there would be nothing to render.
        let template_id = template_id.ok_or_else(|| {
            ApiRejection::BadRequest(
                "`template` is required (the API has no inline HTML body)".into(),
            )
        })?;

        // Fail early with 404 rather than after a pointless render.
        let known: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM printers WHERE name = ?1 COLLATE NOCASE",
                [&req.printer],
                |r| r.get(0),
            )
            .map_err(ApiRejection::from)?;
        if known == 0 {
            return Err(ApiRejection::NotFound(format!(
                "Printer '{}' not found",
                req.printer
            )));
        }

        Some(template_id)
    };

    // Run the real pipeline. This used to insert a row with
    // `status = 'queued'` and return 202 without printing anything, so every
    // API caller got a cheerful "queued" and no paper.
    let print_req = crate::commands::print::PrintRequest {
        printer_name: req.printer.clone(),
        html: String::new(),
        page_width_mm: None,
        page_height_mm: None,
        orientation: settings
            .get("orientation")
            .and_then(|o| o.as_str())
            .map(str::to_string),
        copies: Some(copies),
        margin_top: None,
        margin_right: None,
        margin_bottom: None,
        margin_left: None,
        fit_mode: settings
            .get("fit")
            .and_then(|f| f.as_str())
            .map(str::to_string),
        page_range: settings
            .get("page_range")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        grayscale: settings.get("grayscale").and_then(|v| v.as_bool()),
        http_method: settings
            .get("http_method")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        template_id,
        data: req.data.clone(),
        data_url: req.data_url.clone(),
        test: req.test,
        source: Some("api".into()),
        // Recorded by the begin_job INSERT under a unique index; `check_auth`
        // only fast-paths an existing row with this key.
        idempotency_key,
    };

    let outcome =
        crate::commands::print::run_print(&state.cache_dir, &state.db, &state.queue, print_req)
            .await;

    match outcome {
        Ok(res) if res.success => Ok((
            StatusCode::OK,
            Json(json!({
                "job_id": res.job_id,
                "status": "success",
                "duration_ms": res.duration_ms,
            })),
        )),
        Ok(res) => {
            let err = res.error.unwrap_or_else(|| "print failed".into());
            Err(ApiRejection::from(crate::error::AppError::Internal(err)))
        }
        // Lost the insert race for this key: the unique index recorded the
        // winner's row before either request printed, so report that job
        // instead of printing again (P12). Same body as the middleware's
        // fast-path replay above.
        Err(crate::error::AppError::DuplicateJob(id)) => Ok((
            StatusCode::OK,
            Json(json!({
                "status": "duplicate",
                "message": "idempotency key already used; job not created",
                "job_id": id.to_string()
            })),
        )),
        Err(e) => Err(ApiRejection::from(e)),
    }
}

#[derive(Deserialize)]
struct BatchPrintRequest {
    template: Option<String>,
    printer: String,
    data: Value,
    mode: Option<String>,
}

async fn batch_print(
    State(state): State<ApiState>,
    Json(req): Json<BatchPrintRequest>,
) -> Result<(StatusCode, Json<Value>), ApiRejection> {
    let db = state.db.clone();
    let records = req
        .data
        .as_array()
        .ok_or_else(|| ApiRejection::BadRequest("data must be a JSON array".into()))?;

    // Validate the request shape before touching the database (P3): an
    // empty batch queues nothing to print, and a 5,000-record cap is what
    // the IPC batch command enforces too.
    if records.is_empty() {
        return Err(ApiRejection::BadRequest(
            "data must contain at least one record".into(),
        ));
    }
    if records.len() > crate::commands::batch::DEFAULT_MAX_RECORDS {
        return Err(ApiRejection::BadRequest(format!(
            "batch too large: {} records (max {})",
            records.len(),
            crate::commands::batch::DEFAULT_MAX_RECORDS
        )));
    }
    let mode = req.mode.unwrap_or_else(|| "per_record".into());
    if mode != "per_record" {
        return Err(ApiRejection::BadRequest(format!(
            "invalid mode '{}': only 'per_record' is supported",
            mode
        )));
    }

    let guard = db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection();
    let tx = conn.unchecked_transaction().map_err(ApiRejection::from)?;

    let template_id: i64 = match &req.template {
        Some(n) if !n.is_empty() => tx
            .query_row(
                "SELECT id FROM templates WHERE name = ?1 COLLATE NOCASE AND sync_state <> 'deleted_pending'",
                [n],
                |r| r.get(0),
            )
            .map_err(|_| ApiRejection::NotFound(format!("Template '{}' not found", n)))?,
        _ => return Err(ApiRejection::BadRequest("template is required".into())),
    };

    let printer_id: i64 = tx
        .query_row(
            "SELECT id FROM printers WHERE name = ?1 COLLATE NOCASE",
            [&req.printer],
            |r| r.get(0),
        )
        .map_err(|_| ApiRejection::NotFound(format!("Printer '{}' not found", req.printer)))?;

    tx.execute(
        "INSERT INTO batches (template_id, printer_id, total, mode, status)
         VALUES (?1, ?2, ?3, ?4, 'queued')",
        rusqlite::params![template_id, printer_id, records.len() as i64, mode],
    )
    .map_err(ApiRejection::from)?;
    let batch_id = tx.last_insert_rowid();

    // per_record only: one queued job per record, each carrying its
    // own payload in `data_json` — without it the worker would have
    // nothing to render (P3).
    for (i, record) in records.iter().enumerate() {
        tx.execute(
            "INSERT INTO print_jobs
                   (batch_id, record_index, template_id,
                    printer_id, source, status, copies, is_test, data_json)
                 VALUES (?1, ?2, ?3, ?4, 'api', 'queued', 1, 0, ?5)",
            rusqlite::params![
                batch_id,
                i as i64,
                template_id,
                printer_id,
                record.to_string()
            ],
        )
        .map_err(ApiRejection::from)?;
    }

    tx.commit().map_err(ApiRejection::from)?;
    drop(guard);

    // The rows are `queued`; wake the worker that prints them (P3).
    state.queue.kick();

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "batch_id": batch_id.to_string(),
            "status": "queued",
            "records": records.len(),
            "mode": mode,
        })),
    ))
}

async fn get_job(
    State(state): State<ApiState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiRejection> {
    let db = state.db.clone();
    let guard = db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection();

    let mut stmt = conn
        .prepare(
            "SELECT id, status, error, duration_ms, copies, source, created_at
             FROM print_jobs WHERE id = ?1",
        )
        .map_err(ApiRejection::from)?;

    let mut rows = stmt.query([id]).map_err(ApiRejection::from)?;
    let row = rows
        .next()
        .map_err(ApiRejection::from)?
        .ok_or_else(|| ApiRejection::NotFound(format!("Job {} not found", id)))?;

    Ok(Json(json!({
        "id": row.get::<_, i64>(0)?,
        "status": row.get::<_, String>(1)?,
        "error": row.get::<_, Option<String>>(2)?,
        "duration_ms": row.get::<_, Option<i64>>(3)?,
        "copies": row.get::<_, i64>(4)?,
        "source": row.get::<_, String>(5)?,
        "created_at": row.get::<_, String>(6)?,
    })))
}

async fn list_jobs(State(state): State<ApiState>) -> Result<Json<Value>, ApiRejection> {
    let db = state.db;
    let guard = db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection();

    let mut stmt = conn
        .prepare(
            "SELECT id, status, source, copies, created_at FROM print_jobs ORDER BY id DESC LIMIT 200",
        )
        .map_err(ApiRejection::from)?;

    let jobs: Vec<Value> = stmt
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "status": row.get::<_, String>(1)?,
                "source": row.get::<_, String>(2)?,
                "copies": row.get::<_, i64>(3)?,
                "created_at": row.get::<_, String>(4)?,
            }))
        })
        .map_err(ApiRejection::from)?
        .filter_map(Result::ok)
        .collect();

    let count = jobs.len();
    Ok(Json(json!({ "jobs": jobs, "count": count })))
}

async fn retry_job(
    State(state): State<ApiState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiRejection> {
    let db = state.db.clone();
    let guard = db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection();

    // Only a terminal row may be re-queued: re-queuing a `printing` row
    // would let the worker claim it while the direct pipeline still runs
    // it, and re-queuing a `queued` row would print it twice (P3).
    let affected = conn
        .execute(
            "UPDATE print_jobs SET status='queued', error=NULL, started_at=NULL,
                    finished_at=NULL, duration_ms=NULL, timings_json=NULL
             WHERE id = ?1 AND status IN ('failed', 'cancelled')",
            [id],
        )
        .map_err(ApiRejection::from)?;

    if affected == 0 {
        let exists: i64 = conn
            .query_row("SELECT COUNT(*) FROM print_jobs WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap_or(0);
        if exists == 0 {
            return Err(ApiRejection::NotFound(format!("Job {} not found", id)));
        }
        return Err(ApiRejection::BadRequest(
            "Only a failed or cancelled job can be retried; a finished job reprints instead".into(),
        ));
    }
    drop(guard);

    // The row is `queued` again; wake the worker that prints it (P3).
    state.queue.kick();

    Ok(Json(
        json!({ "job_id": id.to_string(), "status": "queued" }),
    ))
}

async fn cancel_job(
    State(state): State<ApiState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiRejection> {
    let db = state.db.clone();
    let guard = db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection();

    let affected = conn
        .execute(
            "UPDATE print_jobs SET status='cancelled'
             WHERE id = ?1 AND status = 'queued'",
            [id],
        )
        .map_err(ApiRejection::from)?;

    if affected == 0 {
        return Err(ApiRejection::BadRequest(
            "Job is not cancellable (already started or finished)".into(),
        ));
    }
    crate::metrics::count_finished("cancelled");

    Ok(StatusCode::NO_CONTENT)
}

/// Operational counters for dashboards and smoke checks: jobs by
/// status, active batches, and printers the queue currently serialises.
/// One GROUP BY plus two cheap counts — no per-row work.
/// Shared by the JSON and Prometheus renderings: job counts per
/// status plus the number of batches still printing.
fn read_metric_counts(
    state: &ApiState,
) -> Result<(std::collections::HashMap<String, i64>, i64), ApiRejection> {
    let guard = state.db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection();

    let mut by_status: std::collections::HashMap<String, i64> = [
        ("queued", 0),
        ("printing", 0),
        ("success", 0),
        ("failed", 0),
        ("cancelled", 0),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), *v))
    .collect();
    let mut stmt = conn
        .prepare("SELECT status, COUNT(*) FROM print_jobs GROUP BY status")
        .map_err(ApiRejection::from)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(ApiRejection::from)?;
    for row in rows {
        let (status, count) = row.map_err(ApiRejection::from)?;
        by_status.insert(status, count);
    }
    let batches_active: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM batches WHERE status IN ('queued', 'printing')",
            [],
            |r| r.get(0),
        )
        .map_err(ApiRejection::from)?;
    Ok((by_status, batches_active))
}

/// Operational counters for dashboards and smoke checks: jobs by
/// status, active batches, and printers the queue currently serialises.
/// One GROUP BY plus two cheap counts — no per-row work.
async fn metrics(State(state): State<ApiState>) -> Result<Json<Value>, ApiRejection> {
    let (by_status, batches_active) = read_metric_counts(&state)?;

    let finished = crate::metrics::finished_counts();
    Ok(Json(json!({
        "jobs": by_status,
        "batches": { "active": batches_active },
        "printers": { "tracked": state.queue.tracked_printers().await },
        "completed": {
            "success": finished.0,
            "failed": finished.1,
            "cancelled": finished.2,
        },
    })))
}

/// Prometheus text exposition (no client library: the shape is three
/// gauges and the label set is a fixed enum, so rendering is trivial).
/// Same numbers as `/v1/metrics`, scrapable by any collector.
async fn metrics_prometheus(State(state): State<ApiState>) -> impl IntoResponse {
    let (by_status, batches_active) = read_metric_counts(&state)?;
    let tracked = state.queue.tracked_printers().await;
    let finished = crate::metrics::finished_counts();
    let out = crate::metrics::render_prometheus(&by_status, batches_active, tracked, finished);
    Ok::<_, ApiRejection>((
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; version=0.0.4",
        )],
        out,
    ))
}

async fn openapi() -> Json<Value> {
    Json(serde_json::to_value(crate::api::openapi::OpenApiSpec::default()).unwrap())
}

/// Map internal errors onto HTTP responses instead of panicking.
pub struct ApiRejection(AppError);

impl From<AppError> for ApiRejection {
    fn from(e: AppError) -> Self {
        ApiRejection(e)
    }
}

impl From<rusqlite::Error> for ApiRejection {
    fn from(e: rusqlite::Error) -> Self {
        ApiRejection(AppError::from(e))
    }
}

impl From<std::sync::PoisonError<std::sync::MutexGuard<'_, crate::db::Database>>> for ApiRejection {
    fn from(_: std::sync::PoisonError<std::sync::MutexGuard<'_, crate::db::Database>>) -> Self {
        ApiRejection(AppError::Internal("DB lock poisoned".into()))
    }
}

impl IntoResponse for ApiRejection {
    fn into_response(self) -> Response {
        let (status, msg) = match &self.0 {
            AppError::NotFound(m) => (StatusCode::NOT_FOUND, m.clone()),
            AppError::Validation(m) => (StatusCode::BAD_REQUEST, m.clone()),
            _ => (StatusCode::INTERNAL_SERVER_ERROR, self.0.to_string()),
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

impl ApiRejection {
    #[allow(non_snake_case)]
    fn NotFound(m: String) -> Self {
        ApiRejection(AppError::NotFound(m))
    }
    #[allow(non_snake_case)]
    fn BadRequest(m: String) -> Self {
        ApiRejection(AppError::Validation(m))
    }
}
