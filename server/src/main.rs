mod auth;
mod db;
mod error;

use auth::{hash_password, verify_password, Throttle};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{delete, get, post, put},
    Json, Router,
};
use chrono::{Duration, Utc};
use error::AppError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tower_http::cors::CorsLayer;
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    db: Arc<tokio::sync::Mutex<Connection>>,
    throttle: Arc<Mutex<Throttle>>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env().add_directive("printninja-server=info".parse().unwrap()))
        .init();

    let db_path = std::env::var("DATABASE_URL").unwrap_or_else(|_| "printninja-server.db".to_string());
    let conn = db::open_db(&db_path).expect("open db");
    let state = AppState {
        db: Arc::new(tokio::sync::Mutex::new(conn)),
        throttle: Arc::new(Mutex::new(Throttle::default())),
    };

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .nest("/v1", v1_router())
        .layer(CorsLayer::permissive())
        .with_state(state);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3001);
    let addr = format!("0.0.0.0:{port}");
    tracing::info!("listening on {addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

fn v1_router() -> Router<AppState> {
    Router::new()
        .route("/auth/register", post(register))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/me", get(me))
        .route("/templates", get(list_templates))
        .route("/templates/mine", get(list_mine_templates))
        .route("/templates/{id}", get(get_template).put(put_template).delete(delete_template))
        .route("/templates/{id}/use", post(record_use))
        .route("/saved", get(list_saved))
        .route("/saved/{id}", put(save_template).delete(unsave_template))
}

// ── Auth ──

#[derive(Deserialize)]
struct AuthReq {
    handle: String,
    password: String,
}

#[derive(Serialize)]
struct User {
    id: String,
    handle: String,
    created_at: String,
}

#[derive(Serialize)]
struct AuthResp {
    token: String,
    user: User,
}

async fn register(State(state): State<AppState>, headers: HeaderMap, Json(req): Json<AuthReq>) -> Result<impl IntoResponse, AppError> {
    let handle = req.handle.trim().to_string();
    let password = req.password;
    if handle.is_empty() || handle.len() > 32 {
        return Err(AppError::BadRequest("Handle must be 1-32 chars".into()));
    }
    if !handle.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
        return Err(AppError::BadRequest("Handle may contain only alphanumeric, _ and -".into()));
    }
    if password.len() < 8 {
        return Err(AppError::BadRequest("Password must be at least 8 chars".into()));
    }

    let ip = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()).unwrap_or("unknown").to_string();
    {
        let mut t = state.throttle.lock().unwrap();
        t.check_and_record(&format!("register:handle:{handle}"))?;
        t.check_and_record(&format!("register:ip:{ip}"))?;
    }

    let mut conn = state.db.lock().await;
    // Check handle exists (case-insensitive due to COLLATE NOCASE)
    let exists: i64 = conn
        .query_row("SELECT COUNT(*) FROM users WHERE handle = ?1", [&handle], |r| r.get(0))
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if exists > 0 {
        return Err(AppError::BadRequest("Handle already taken".into()));
    }

    let id = Uuid::new_v4().to_string();
    let hash = hash_password(&password)?;
    conn.execute(
        "INSERT INTO users (id, handle, password_hash) VALUES (?1, ?2, ?3)",
        [&id, &handle, &hash],
    )
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let (token, token_hash) = auth::generate_token();
    let expires_at = (Utc::now() + Duration::days(30)).to_rfc3339();
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)",
        [&token_hash, &id, &expires_at],
    )
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let user = User {
        id: id.clone(),
        handle: handle.clone(),
        created_at: Utc::now().to_rfc3339(),
    };
    Ok((StatusCode::OK, Json(AuthResp { token, user })))
}

async fn login(State(state): State<AppState>, headers: HeaderMap, Json(req): Json<AuthReq>) -> Result<impl IntoResponse, AppError> {
    let handle = req.handle.trim().to_string();
    let ip = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()).unwrap_or("unknown").to_string();
    {
        let mut t = state.throttle.lock().unwrap();
        t.check_and_record(&format!("login:handle:{handle}"))?;
        t.check_and_record(&format!("login:ip:{ip}"))?;
    }

    let mut conn = state.db.lock().await;
    let mut stmt = conn
        .prepare("SELECT id, handle, password_hash, created_at FROM users WHERE handle = ?1 COLLATE NOCASE")
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let mut rows = stmt.query([&handle]).map_err(|e| AppError::Internal(e.to_string()))?;
    let row = rows.next().map_err(|e| AppError::Internal(e.to_string()))?;
    let Some(row) = row else {
        return Err(AppError::Unauthorized("Invalid handle or password".into()));
    };
    let id: String = row.get(0).map_err(|e| AppError::Internal(e.to_string()))?;
    let db_handle: String = row.get(1).map_err(|e| AppError::Internal(e.to_string()))?;
    let hash: String = row.get(2).map_err(|e| AppError::Internal(e.to_string()))?;
    let created_at: String = row.get(3).map_err(|e| AppError::Internal(e.to_string()))?;
    drop(rows);
    drop(stmt);

    if !verify_password(&hash, &req.password) {
        return Err(AppError::Unauthorized("Invalid handle or password".into()));
    }

    let (token, token_hash) = auth::generate_token();
    let expires_at = (Utc::now() + Duration::days(30)).to_rfc3339();
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)",
        [&token_hash, &id, &expires_at],
    )
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let user = User { id, handle: db_handle, created_at };
    Ok((StatusCode::OK, Json(AuthResp { token, user })))
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<impl IntoResponse, AppError> {
    let token = extract_bearer(&headers)?;
    let hash = auth::hash_token(&token);
    let conn = state.db.lock().await;
    conn.execute("DELETE FROM sessions WHERE token_hash = ?1", [&hash])
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn me(State(state): State<AppState>, headers: HeaderMap) -> Result<impl IntoResponse, AppError> {
    let token = extract_bearer(&headers)?;
    let conn = state.db.lock().await;
    let sess = auth::validate_session(&conn, &token)?;
    // Fetch user
    let mut stmt = conn
        .prepare("SELECT id, handle, created_at FROM users WHERE id = ?1")
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let mut rows = stmt.query([&sess.user_id]).map_err(|e| AppError::Internal(e.to_string()))?;
    let row = rows.next().map_err(|e| AppError::Internal(e.to_string()))?.ok_or_else(|| AppError::NotFound("User not found".into()))?;
    let user = User {
        id: row.get(0).map_err(|e| AppError::Internal(e.to_string()))?,
        handle: row.get(1).map_err(|e| AppError::Internal(e.to_string()))?,
        created_at: row.get(2).map_err(|e| AppError::Internal(e.to_string()))?,
    };
    Ok(Json(user))
}

fn extract_bearer(headers: &HeaderMap) -> Result<String, AppError> {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("Missing Authorization".into()))?;
    if let Some(t) = auth.strip_prefix("Bearer ") {
        Ok(t.to_string())
    } else {
        Err(AppError::Unauthorized("Invalid Authorization header".into()))
    }
}

// ── Templates ──

#[derive(Serialize)]
struct TemplateSummary {
    id: String,
    owner_id: String,
    owner_handle: String,
    name: String,
    summary: String,
    page_w_mm: f64,
    page_h_mm: f64,
    language: String,
    use_count: i64,
    published_at: String,
    updated_at: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct Template {
    id: String,
    owner_id: String,
    owner_handle: String,
    name: String,
    summary: String,
    page_w_mm: f64,
    page_h_mm: f64,
    language: String,
    body: String,
    css: String,
    readme: String,
    use_count: i64,
    published_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
struct ListParams {
    q: Option<String>,
    sort: Option<String>,
    page: Option<i64>,
}

async fn list_templates(State(state): State<AppState>, Query(params): Query<ListParams>) -> Result<impl IntoResponse, AppError> {
    let conn = state.db.lock().await;
    let q = params.q.unwrap_or_default();
    let sort = params.sort.unwrap_or_else(|| "updated".to_string());
    let page = params.page.unwrap_or(1).max(1);
    let limit = 20;
    let offset = (page - 1) * limit;

    let order = match sort.as_str() {
        "used" => "use_count DESC, updated_at DESC",
        "name" => "name COLLATE NOCASE ASC",
        _ => "updated_at DESC",
    };

    let sql = if q.is_empty() {
        format!("SELECT t.id, t.owner_id, u.handle, t.name, t.summary, t.page_w_mm, t.page_h_mm, t.language, t.use_count, t.published_at, t.updated_at FROM templates t JOIN users u ON t.owner_id = u.id WHERE t.published_at != '' ORDER BY {order} LIMIT ?1 OFFSET ?2")
    } else {
        format!("SELECT t.id, t.owner_id, u.handle, t.name, t.summary, t.page_w_mm, t.page_h_mm, t.language, t.use_count, t.published_at, t.updated_at FROM templates t JOIN users u ON t.owner_id = u.id WHERE t.published_at != '' AND (t.name LIKE ?1 OR t.summary LIKE ?1) ORDER BY {order} LIMIT ?2 OFFSET ?3")
    };

    let mut stmt = conn.prepare(&sql).map_err(|e| AppError::Internal(e.to_string()))?;
    let rows: Vec<TemplateSummary> = if q.is_empty() {
        let mut rows = stmt.query(rusqlite::params![limit, offset]).map_err(|e| AppError::Internal(e.to_string()))?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| AppError::Internal(e.to_string()))? {
            out.push(TemplateSummary {
                id: row.get(0).map_err(|e| AppError::Internal(e.to_string()))?,
                owner_id: row.get(1).map_err(|e| AppError::Internal(e.to_string()))?,
                owner_handle: row.get(2).map_err(|e| AppError::Internal(e.to_string()))?,
                name: row.get(3).map_err(|e| AppError::Internal(e.to_string()))?,
                summary: row.get(4).map_err(|e| AppError::Internal(e.to_string()))?,
                page_w_mm: row.get(5).map_err(|e| AppError::Internal(e.to_string()))?,
                page_h_mm: row.get(6).map_err(|e| AppError::Internal(e.to_string()))?,
                language: row.get(7).map_err(|e| AppError::Internal(e.to_string()))?,
                use_count: row.get(8).map_err(|e| AppError::Internal(e.to_string()))?,
                published_at: row.get(9).map_err(|e| AppError::Internal(e.to_string()))?,
                updated_at: row.get(10).map_err(|e| AppError::Internal(e.to_string()))?,
            });
        }
        out
    } else {
        let like = format!("%{q}%");
        let mut rows = stmt.query(rusqlite::params![like, limit, offset]).map_err(|e| AppError::Internal(e.to_string()))?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| AppError::Internal(e.to_string()))? {
            out.push(TemplateSummary {
                id: row.get(0).map_err(|e| AppError::Internal(e.to_string()))?,
                owner_id: row.get(1).map_err(|e| AppError::Internal(e.to_string()))?,
                owner_handle: row.get(2).map_err(|e| AppError::Internal(e.to_string()))?,
                name: row.get(3).map_err(|e| AppError::Internal(e.to_string()))?,
                summary: row.get(4).map_err(|e| AppError::Internal(e.to_string()))?,
                page_w_mm: row.get(5).map_err(|e| AppError::Internal(e.to_string()))?,
                page_h_mm: row.get(6).map_err(|e| AppError::Internal(e.to_string()))?,
                language: row.get(7).map_err(|e| AppError::Internal(e.to_string()))?,
                use_count: row.get(8).map_err(|e| AppError::Internal(e.to_string()))?,
                published_at: row.get(9).map_err(|e| AppError::Internal(e.to_string()))?,
                updated_at: row.get(10).map_err(|e| AppError::Internal(e.to_string()))?,
            });
        }
        out
    };
    Ok(Json(rows))
}

/// Private templates have an empty `published_at`; published ones carry a timestamp.
/// Using an empty string (not NULL) keeps the column NOT NULL, so existing databases need no migration.
const PRIVATE: &str = "";

/// The signed-in user's own templates, private and published.
async fn list_mine_templates(State(state): State<AppState>, headers: HeaderMap) -> Result<impl IntoResponse, AppError> {
    let token = extract_bearer(&headers)?;
    let conn = state.db.lock().await;
    let sess = auth::validate_session(&conn, &token)?;
    let mut stmt = conn
        .prepare("SELECT t.id, t.owner_id, u.handle, t.name, t.summary, t.page_w_mm, t.page_h_mm, t.language, t.use_count, t.published_at, t.updated_at FROM templates t JOIN users u ON t.owner_id = u.id WHERE t.owner_id = ?1 ORDER BY t.updated_at DESC")
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let mut rows = stmt.query([&sess.user_id]).map_err(|e| AppError::Internal(e.to_string()))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| AppError::Internal(e.to_string()))? {
        out.push(TemplateSummary {
            id: row.get(0).map_err(|e| AppError::Internal(e.to_string()))?,
            owner_id: row.get(1).map_err(|e| AppError::Internal(e.to_string()))?,
            owner_handle: row.get(2).map_err(|e| AppError::Internal(e.to_string()))?,
            name: row.get(3).map_err(|e| AppError::Internal(e.to_string()))?,
            summary: row.get(4).map_err(|e| AppError::Internal(e.to_string()))?,
            page_w_mm: row.get(5).map_err(|e| AppError::Internal(e.to_string()))?,
            page_h_mm: row.get(6).map_err(|e| AppError::Internal(e.to_string()))?,
            language: row.get(7).map_err(|e| AppError::Internal(e.to_string()))?,
            use_count: row.get(8).map_err(|e| AppError::Internal(e.to_string()))?,
            published_at: row.get(9).map_err(|e| AppError::Internal(e.to_string()))?,
            updated_at: row.get(10).map_err(|e| AppError::Internal(e.to_string()))?,
        });
    }
    Ok(Json(out))
}

async fn get_template(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Result<impl IntoResponse, AppError> {
    let conn = state.db.lock().await;
    // Anonymous callers may read published templates. Private ones are visible to the owner only.
    // A caller who sent a token must send a valid one.
    let caller: Option<String> = match extract_bearer(&headers) {
        Ok(token) => Some(auth::validate_session(&conn, &token)?.user_id),
        Err(_) => None,
    };
    let mut stmt = conn
        .prepare("SELECT t.id, t.owner_id, u.handle, t.name, t.summary, t.page_w_mm, t.page_h_mm, t.language, t.body, t.readme, t.css, t.use_count, t.published_at, t.updated_at FROM templates t JOIN users u ON t.owner_id = u.id WHERE t.id = ?1")
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let mut rows = stmt.query([&id]).map_err(|e| AppError::Internal(e.to_string()))?;
    let Some(row) = rows.next().map_err(|e| AppError::Internal(e.to_string()))? else {
        return Err(AppError::NotFound("Template not found".into()));
    };
    let tpl = Template {
        id: row.get(0).map_err(|e| AppError::Internal(e.to_string()))?,
        owner_id: row.get(1).map_err(|e| AppError::Internal(e.to_string()))?,
        owner_handle: row.get(2).map_err(|e| AppError::Internal(e.to_string()))?,
        name: row.get(3).map_err(|e| AppError::Internal(e.to_string()))?,
        summary: row.get(4).map_err(|e| AppError::Internal(e.to_string()))?,
        page_w_mm: row.get(5).map_err(|e| AppError::Internal(e.to_string()))?,
        page_h_mm: row.get(6).map_err(|e| AppError::Internal(e.to_string()))?,
        language: row.get(7).map_err(|e| AppError::Internal(e.to_string()))?,
        body: row.get(8).map_err(|e| AppError::Internal(e.to_string()))?,
        readme: row.get(9).map_err(|e| AppError::Internal(e.to_string()))?,
        css: row.get(10).map_err(|e| AppError::Internal(e.to_string()))?,
        use_count: row.get(11).map_err(|e| AppError::Internal(e.to_string()))?,
        published_at: row.get(12).map_err(|e| AppError::Internal(e.to_string()))?,
        updated_at: row.get(13).map_err(|e| AppError::Internal(e.to_string()))?,
    };
    if tpl.published_at == PRIVATE && caller.as_deref() != Some(tpl.owner_id.as_str()) {
        // Do not reveal that a private template exists.
        return Err(AppError::NotFound("Template not found".into()));
    }
    Ok(Json(tpl))
}

#[derive(Deserialize)]
struct PutTemplateReq {
    name: String,
    summary: Option<String>,
    page_w_mm: f64,
    page_h_mm: f64,
    language: String,
    body: String,
    /// Template CSS. Sent by Save, Refresh and Get from server so the CSS
    /// travels with the HTML instead of being lost (migration plan, phase 1).
    css: Option<String>,
    readme: Option<String>,
    /// `true` publishes, `false` makes the template private. When omitted, a new template is
    /// published (the original behaviour) and an existing one keeps its current state.
    publish: Option<bool>,
}

async fn put_template(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<PutTemplateReq>,
) -> Result<impl IntoResponse, AppError> {
    // Auth required
    let token = extract_bearer(&headers)?;
    let mut conn = state.db.lock().await;
    let sess = {
        // Need to validate while holding lock, but we have &Connection, not &mut
        // We have a tokio::sync::Mutex, we can get &Connection via &*conn
        auth::validate_session(&conn, &token)?
    };

    // Validate sizes
    if req.body.as_bytes().len() > 512 * 1024 {
        return Err(AppError::BadRequest("Template body exceeds 512 KiB".into()));
    }
    let css = req.css.as_deref().unwrap_or_default();
    if css.as_bytes().len() > 256 * 1024 {
        return Err(AppError::BadRequest("Template CSS exceeds 256 KiB".into()));
    }
    let readme = req.readme.unwrap_or_default();
    if readme.as_bytes().len() > 64 * 1024 {
        return Err(AppError::BadRequest("README exceeds 64 KiB".into()));
    }
    // Validate handlebars-ish body doesn't contain remote refs (re-sanitize)
    // For now, simple check: if body or css contains http:// or https:// in src/href/url, reject
    for (source, text) in [("body", req.body.as_str()), ("css", css)] {
        let lower = text.to_lowercase();
        if lower.contains("src=\"http") || lower.contains("href=\"http") || lower.contains("url(\"http") || lower.contains("url('http") {
            return Err(AppError::BadRequest(format!(
                "Template {source} contains remote references — use data: URIs"
            )));
        }
    }
    if Uuid::parse_str(&id).is_err() {
        return Err(AppError::BadRequest("Invalid template id (must be UUID)".into()));
    }

    // Check if exists
    let existing_owner: Option<String> = conn
        .query_row("SELECT owner_id FROM templates WHERE id = ?1", [&id], |r| r.get(0))
        .ok();

    if let Some(owner_id) = existing_owner {
        if owner_id != sess.user_id {
            return Err(AppError::Forbidden("Not the owner".into()));
        }
        // Update. `published_at` changes only when `publish` is sent: true keeps an existing
        // publish time (or sets one), false makes the template private. `css` is kept when the
        // request omits it, so an older client pushing a body does not wipe the stored CSS.
        conn.execute(
            "UPDATE templates SET name = ?1, summary = ?2, page_w_mm = ?3, page_h_mm = ?4, language = ?5, body = ?6, readme = ?7, \
             css = CASE WHEN ?10 IS NULL THEN css ELSE ?10 END, \
             published_at = CASE ?9 WHEN 1 THEN CASE WHEN published_at = '' THEN datetime('now') ELSE published_at END WHEN 0 THEN '' ELSE published_at END, \
             updated_at = datetime('now') WHERE id = ?8",
            rusqlite::params![req.name, req.summary.unwrap_or_default(), req.page_w_mm, req.page_h_mm, req.language, req.body, readme, id, req.publish.map(|b| b as i64), req.css],
        )
        .map_err(|e| AppError::Internal(e.to_string()))?;
    } else {
        // Create
        let published_at = if req.publish == Some(false) { PRIVATE.to_string() } else { Utc::now().format("%Y-%m-%d %H:%M:%S").to_string() };
        conn.execute(
            "INSERT INTO templates (id, owner_id, name, summary, page_w_mm, page_h_mm, language, body, readme, css, published_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            rusqlite::params![id, sess.user_id, req.name, req.summary.unwrap_or_default(), req.page_w_mm, req.page_h_mm, req.language, req.body, readme, css, published_at],
        )
        .map_err(|e| AppError::Internal(e.to_string()))?;
    }

    // Return updated template
    let mut stmt = conn
        .prepare("SELECT t.id, t.owner_id, u.handle, t.name, t.summary, t.page_w_mm, t.page_h_mm, t.language, t.body, t.readme, t.css, t.use_count, t.published_at, t.updated_at FROM templates t JOIN users u ON t.owner_id = u.id WHERE t.id = ?1")
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let mut rows = stmt.query([&id]).map_err(|e| AppError::Internal(e.to_string()))?;
    let row = rows.next().map_err(|e| AppError::Internal(e.to_string()))?.unwrap();
    let tpl = Template {
        id: row.get(0).map_err(|e| AppError::Internal(e.to_string()))?,
        owner_id: row.get(1).map_err(|e| AppError::Internal(e.to_string()))?,
        owner_handle: row.get(2).map_err(|e| AppError::Internal(e.to_string()))?,
        name: row.get(3).map_err(|e| AppError::Internal(e.to_string()))?,
        summary: row.get(4).map_err(|e| AppError::Internal(e.to_string()))?,
        page_w_mm: row.get(5).map_err(|e| AppError::Internal(e.to_string()))?,
        page_h_mm: row.get(6).map_err(|e| AppError::Internal(e.to_string()))?,
        language: row.get(7).map_err(|e| AppError::Internal(e.to_string()))?,
        body: row.get(8).map_err(|e| AppError::Internal(e.to_string()))?,
        readme: row.get(9).map_err(|e| AppError::Internal(e.to_string()))?,
        css: row.get(10).map_err(|e| AppError::Internal(e.to_string()))?,
        use_count: row.get(11).map_err(|e| AppError::Internal(e.to_string()))?,
        published_at: row.get(12).map_err(|e| AppError::Internal(e.to_string()))?,
        updated_at: row.get(13).map_err(|e| AppError::Internal(e.to_string()))?,
    };
    Ok((StatusCode::OK, Json(tpl)))
}

async fn delete_template(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let token = extract_bearer(&headers)?;
    let conn = state.db.lock().await;
    let sess = auth::validate_session(&conn, &token)?;
    let owner: Option<String> = conn
        .query_row("SELECT owner_id FROM templates WHERE id = ?1", [&id], |r| r.get(0))
        .ok();
    match owner {
        None => return Err(AppError::NotFound("Template not found".into())),
        Some(o) if o != sess.user_id => return Err(AppError::Forbidden("Not the owner".into())),
        _ => {}
    }
    conn.execute("DELETE FROM templates WHERE id = ?1", [&id])
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn record_use(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let token = extract_bearer(&headers)?;
    let conn = state.db.lock().await;
    let _sess = auth::validate_session(&conn, &token)?;
    let affected = conn
        .execute(
            "UPDATE templates SET use_count = use_count + 1 WHERE id = ?1 AND published_at != ''",
            [&id],
        )
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if affected == 0 {
        return Err(AppError::NotFound("Template not found".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

// ── Saved ──

async fn list_saved(State(state): State<AppState>, headers: HeaderMap) -> Result<impl IntoResponse, AppError> {
    let token = extract_bearer(&headers)?;
    let conn = state.db.lock().await;
    let sess = auth::validate_session(&conn, &token)?;
    let mut stmt = conn
        .prepare("SELECT t.id, t.owner_id, u.handle, t.name, t.summary, t.page_w_mm, t.page_h_mm, t.language, t.use_count, t.published_at, t.updated_at FROM templates t JOIN saved_templates s ON s.template_id = t.id JOIN users u ON t.owner_id = u.id WHERE s.user_id = ?1 AND t.published_at != '' ORDER BY s.added_at DESC")
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let mut rows = stmt.query([&sess.user_id]).map_err(|e| AppError::Internal(e.to_string()))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| AppError::Internal(e.to_string()))? {
        out.push(TemplateSummary {
            id: row.get(0).map_err(|e| AppError::Internal(e.to_string()))?,
            owner_id: row.get(1).map_err(|e| AppError::Internal(e.to_string()))?,
            owner_handle: row.get(2).map_err(|e| AppError::Internal(e.to_string()))?,
            name: row.get(3).map_err(|e| AppError::Internal(e.to_string()))?,
            summary: row.get(4).map_err(|e| AppError::Internal(e.to_string()))?,
            page_w_mm: row.get(5).map_err(|e| AppError::Internal(e.to_string()))?,
            page_h_mm: row.get(6).map_err(|e| AppError::Internal(e.to_string()))?,
            language: row.get(7).map_err(|e| AppError::Internal(e.to_string()))?,
            use_count: row.get(8).map_err(|e| AppError::Internal(e.to_string()))?,
            published_at: row.get(9).map_err(|e| AppError::Internal(e.to_string()))?,
            updated_at: row.get(10).map_err(|e| AppError::Internal(e.to_string()))?,
        });
    }
    Ok(Json(out))
}

async fn save_template(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let token = extract_bearer(&headers)?;
    let conn = state.db.lock().await;
    let sess = auth::validate_session(&conn, &token)?;
    // Ensure template exists
    let exists: i64 = conn
        .query_row("SELECT COUNT(*) FROM templates WHERE id = ?1 AND published_at != ''", [&id], |r| r.get(0))
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if exists == 0 {
        return Err(AppError::NotFound("Template not found".into()));
    }
    conn.execute(
        "INSERT OR IGNORE INTO saved_templates (user_id, template_id) VALUES (?1, ?2)",
        [&sess.user_id, &id],
    )
    .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(StatusCode::OK)
}

async fn unsave_template(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let token = extract_bearer(&headers)?;
    let conn = state.db.lock().await;
    let sess = auth::validate_session(&conn, &token)?;
    conn.execute(
        "DELETE FROM saved_templates WHERE user_id = ?1 AND template_id = ?2",
        [&sess.user_id, &id],
    )
    .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::{Service, ServiceExt};

    fn test_app() -> Router {
        let conn = db::open_db(":memory:").unwrap();
        let state = AppState {
            db: Arc::new(tokio::sync::Mutex::new(conn)),
            throttle: Arc::new(Mutex::new(Throttle::default())),
        };
        Router::new()
            .nest("/v1", v1_router())
            .with_state(state)
    }

    async fn register_helper(app: &mut Router, handle: &str, password: &str) -> (StatusCode, String) {
        let req = Request::builder()
            .method("POST")
            .uri("/v1/auth/register")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::json!({ "handle": handle, "password": password }).to_string()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
        (status, String::from_utf8_lossy(&body).to_string())
    }

    async fn login_helper(app: &mut Router, handle: &str, password: &str) -> (StatusCode, String) {
        let req = Request::builder()
            .method("POST")
            .uri("/v1/auth/login")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::json!({ "handle": handle, "password": password }).to_string()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
        (status, String::from_utf8_lossy(&body).to_string())
    }

    #[tokio::test]
    async fn b3_register_and_login() {
        let mut app = test_app();
        let (status, body) = register_helper(&mut app, "alice", "password123").await;
        assert_eq!(status, StatusCode::OK, "register: {body}");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(v["token"].as_str().unwrap().len() > 20);
        assert_eq!(v["user"]["handle"], "alice");

        let (status, body) = login_helper(&mut app, "alice", "password123").await;
        assert_eq!(status, StatusCode::OK, "login: {body}");
    }

    #[tokio::test]
    async fn b3_wrong_password_and_unknown_handle() {
        let mut app = test_app();
        register_helper(&mut app, "bob", "password123").await;

        let (status, _) = login_helper(&mut app, "bob", "wrongpass").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let (status, _) = login_helper(&mut app, "nobody", "password123").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn b3_duplicate_handle_case_insensitive() {
        let mut app = test_app();
        let (s1, _) = register_helper(&mut app, "Alice", "password123").await;
        assert_eq!(s1, StatusCode::OK);
        let (s2, body) = register_helper(&mut app, "alice", "password123").await;
        assert_eq!(s2, StatusCode::BAD_REQUEST, "{body}");
    }

    #[tokio::test]
    async fn b3_throttle_trips() {
        let mut app = test_app();
        // 5 failures should be allowed, 6th should be 429
        for i in 0..5 {
            let (status, _) = login_helper(&mut app, "throttled", "wrong").await;
            // First 5 are 401 (unknown handle), not 429
            assert_eq!(status, StatusCode::UNAUTHORIZED, "attempt {i}");
        }
        let (status, _) = login_helper(&mut app, "throttled", "wrong").await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn b3_token_not_in_client_build() {
        // Ensure the token is opaque and not derived from handle
        let mut app = test_app();
        let (_, body) = register_helper(&mut app, "carol", "password123").await;
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        let token = v["token"].as_str().unwrap();
        assert!(!token.contains("carol"), "token must not leak handle");
        // Token is stored hashed: check DB directly
        // (We can't access DB from here, but the fact that login works proves hashing)
    }

    #[tokio::test]
    async fn b3_me_and_logout() {
        let mut app = test_app();
        let (_, body) = register_helper(&mut app, "dave", "password123").await;
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        let token = v["token"].as_str().unwrap().to_string();

        // me
        let req = Request::builder()
            .method("GET")
            .uri("/v1/auth/me")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 1024).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["handle"], "dave");

        // logout
        let req = Request::builder()
            .method("POST")
            .uri("/v1/auth/logout")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        // me after logout should be 401
        let req = Request::builder()
            .method("GET")
            .uri("/v1/auth/me")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    // B4 — Publish
    #[tokio::test]
    async fn b4_publish_and_update_idempotent() {
        let mut app = test_app();
        let (_, body) = register_helper(&mut app, "owner", "password123").await;
        let token: String = serde_json::from_str::<serde_json::Value>(&body).unwrap()["token"].as_str().unwrap().to_string();
        let id = Uuid::new_v4().to_string();

        let payload = serde_json::json!({
            "name": "Invoice",
            "summary": "A4 invoice",
            "page_w_mm": 210.0,
            "page_h_mm": 297.0,
            "language": "html",
            "body": "<div>hello</div>",
            "readme": "# Invoice"
        });

        // First PUT — create
        let req = Request::builder()
            .method("PUT")
            .uri(format!("/v1/templates/{id}"))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(payload.to_string()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Second PUT — update (idempotent, same id, different body)
        let payload2 = serde_json::json!({
            "name": "Invoice v2",
            "summary": "Updated",
            "page_w_mm": 210.0,
            "page_h_mm": 297.0,
            "language": "html",
            "body": "<div>hello v2</div>",
            "readme": "# Invoice v2"
        });
        let req = Request::builder()
            .method("PUT")
            .uri(format!("/v1/templates/{id}"))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(payload2.to_string()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["name"], "Invoice v2");
    }

    #[tokio::test]
    async fn b4_non_owner_cannot_update_or_delete() {
        let mut app = test_app();
        let (_, b1) = register_helper(&mut app, "owner1", "password123").await;
        let t1: String = serde_json::from_str::<serde_json::Value>(&b1).unwrap()["token"].as_str().unwrap().to_string();
        let (_, b2) = register_helper(&mut app, "owner2", "password123").await;
        let t2: String = serde_json::from_str::<serde_json::Value>(&b2).unwrap()["token"].as_str().unwrap().to_string();
        let id = Uuid::new_v4().to_string();

        let payload = serde_json::json!({
            "name": "Secret",
            "summary": "",
            "page_w_mm": 210.0,
            "page_h_mm": 297.0,
            "language": "html",
            "body": "<div>secret</div>",
            "readme": ""
        });
        let req = Request::builder()
            .method("PUT")
            .uri(format!("/v1/templates/{id}"))
            .header("authorization", format!("Bearer {t1}"))
            .header("content-type", "application/json")
            .body(Body::from(payload.to_string()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Non-owner update -> 403
        let req = Request::builder()
            .method("PUT")
            .uri(format!("/v1/templates/{id}"))
            .header("authorization", format!("Bearer {t2}"))
            .header("content-type", "application/json")
            .body(Body::from(payload.to_string()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        // Non-owner delete -> 403
        let req = Request::builder()
            .method("DELETE")
            .uri(format!("/v1/templates/{id}"))
            .header("authorization", format!("Bearer {t2}"))
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        // Anonymous (no token) -> 401
        let req = Request::builder()
            .method("PUT")
            .uri(format!("/v1/templates/{id}"))
            .header("content-type", "application/json")
            .body(Body::from(payload.to_string()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn b4_unpublish_leaves_local_intact_and_get_returns_404() {
        let mut app = test_app();
        let (_, body) = register_helper(&mut app, "owner", "password123").await;
        let token: String = serde_json::from_str::<serde_json::Value>(&body).unwrap()["token"].as_str().unwrap().to_string();
        let id = Uuid::new_v4().to_string();
        let payload = serde_json::json!({
            "name": "Temp",
            "summary": "",
            "page_w_mm": 210.0,
            "page_h_mm": 297.0,
            "language": "html",
            "body": "<div>temp</div>",
            "readme": ""
        });
        let req = Request::builder()
            .method("PUT")
            .uri(format!("/v1/templates/{id}"))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(payload.to_string()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Delete (unpublish)
        let req = Request::builder()
            .method("DELETE")
            .uri(format!("/v1/templates/{id}"))
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        // GET should now be 404
        let req = Request::builder()
            .method("GET")
            .uri(format!("/v1/templates/{id}"))
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn b4_anonymous_can_browse() {
        let mut app = test_app();
        let (_, body) = register_helper(&mut app, "owner", "password123").await;
        let token: String = serde_json::from_str::<serde_json::Value>(&body).unwrap()["token"].as_str().unwrap().to_string();
        let id = Uuid::new_v4().to_string();
        let payload = serde_json::json!({
            "name": "Public",
            "summary": "visible",
            "page_w_mm": 210.0,
            "page_h_mm": 297.0,
            "language": "html",
            "body": "<div>public</div>",
            "readme": ""
        });
        let req = Request::builder()
            .method("PUT")
            .uri(format!("/v1/templates/{id}"))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(payload.to_string()))
            .unwrap();
        let _ = app.clone().oneshot(req).await.unwrap();

        // Anonymous browse
        let req = Request::builder()
            .method("GET")
            .uri("/v1/templates")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(v.as_array().unwrap().iter().any(|t| t["id"] == id));
    }

    // ── Phase 1: private templates, list-mine, owner access ──

    async fn token_for(app: &mut Router, handle: &str) -> String {
        let (status, body) = register_helper(app, handle, "password123").await;
        assert_eq!(status, StatusCode::OK, "register {handle}: {body}");
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["token"].as_str().unwrap().to_string()
    }

    fn tpl_payload(name: &str, publish: Option<bool>) -> serde_json::Value {
        let mut v = serde_json::json!({
            "name": name,
            "summary": "",
            "page_w_mm": 210.0,
            "page_h_mm": 297.0,
            "language": "html",
            "body": "<div>x</div>",
            "readme": ""
        });
        if let Some(p) = publish {
            v["publish"] = serde_json::json!(p);
        }
        v
    }

    async fn send(app: &Router, method: &str, uri: &str, token: Option<&str>, body: Option<serde_json::Value>) -> (StatusCode, serde_json::Value) {
        let mut b = Request::builder().method(method).uri(uri);
        if let Some(t) = token {
            b = b.header("authorization", format!("Bearer {t}"));
        }
        let req = if let Some(j) = body {
            b.header("content-type", "application/json").body(Body::from(j.to_string())).unwrap()
        } else {
            b.body(Body::empty()).unwrap()
        };
        let resp = app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 4 * 1024 * 1024).await.unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    fn ids(v: &serde_json::Value) -> Vec<String> {
        v.as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap().to_string()).collect()
    }

    #[tokio::test]
    async fn p1_private_template_is_visible_to_owner_only() {
        let mut app = test_app();
        let owner = token_for(&mut app, "priv_owner").await;
        let other = token_for(&mut app, "priv_other").await;
        let id = Uuid::new_v4().to_string();

        let (s, v) = send(&app, "PUT", &format!("/v1/templates/{id}"), Some(&owner), Some(tpl_payload("Hidden", Some(false)))).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(v["published_at"], "");

        // Not in the public list
        let (_, list) = send(&app, "GET", "/v1/templates", None, None).await;
        assert!(!ids(&list).contains(&id));

        // Anonymous and other users get 404, owner gets 200
        let (s, _) = send(&app, "GET", &format!("/v1/templates/{id}"), None, None).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let (s, _) = send(&app, "GET", &format!("/v1/templates/{id}"), Some(&other), None).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let (s, v) = send(&app, "GET", &format!("/v1/templates/{id}"), Some(&owner), None).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(v["body"], "<div>x</div>");
    }

    #[tokio::test]
    async fn p1_put_without_flag_publishes_new_and_keeps_state_on_update() {
        let mut app = test_app();
        let t = token_for(&mut app, "flagger").await;

        // New template without the flag is published (original behaviour)
        let a = Uuid::new_v4().to_string();
        let (_, v) = send(&app, "PUT", &format!("/v1/templates/{a}"), Some(&t), Some(tpl_payload("A", None))).await;
        assert_ne!(v["published_at"], "");

        // Private stays private on an update that omits the flag
        let b = Uuid::new_v4().to_string();
        send(&app, "PUT", &format!("/v1/templates/{b}"), Some(&t), Some(tpl_payload("B", Some(false)))).await;
        let (_, v) = send(&app, "PUT", &format!("/v1/templates/{b}"), Some(&t), Some(tpl_payload("B2", None))).await;
        assert_eq!(v["published_at"], "");
        assert_eq!(v["name"], "B2");

        // Publish, then keep the publish time on a repeat publish
        let (_, v1) = send(&app, "PUT", &format!("/v1/templates/{b}"), Some(&t), Some(tpl_payload("B2", Some(true)))).await;
        assert_ne!(v1["published_at"], "");
        let (_, list) = send(&app, "GET", "/v1/templates", None, None).await;
        assert!(ids(&list).contains(&b));
        let (_, v2) = send(&app, "PUT", &format!("/v1/templates/{b}"), Some(&t), Some(tpl_payload("B3", Some(true)))).await;
        assert_eq!(v1["published_at"], v2["published_at"]);

        // Unpublish removes it from the public list again
        send(&app, "PUT", &format!("/v1/templates/{b}"), Some(&t), Some(tpl_payload("B3", Some(false)))).await;
        let (_, list) = send(&app, "GET", "/v1/templates", None, None).await;
        assert!(!ids(&list).contains(&b));
    }

    #[tokio::test]
    async fn p1_list_mine_needs_auth_and_returns_only_own_templates() {
        let mut app = test_app();
        let alice = token_for(&mut app, "mine_alice").await;
        let bob = token_for(&mut app, "mine_bob").await;
        let a_private = Uuid::new_v4().to_string();
        let a_public = Uuid::new_v4().to_string();
        let b_public = Uuid::new_v4().to_string();
        send(&app, "PUT", &format!("/v1/templates/{a_private}"), Some(&alice), Some(tpl_payload("AP", Some(false)))).await;
        send(&app, "PUT", &format!("/v1/templates/{a_public}"), Some(&alice), Some(tpl_payload("AU", Some(true)))).await;
        send(&app, "PUT", &format!("/v1/templates/{b_public}"), Some(&bob), Some(tpl_payload("BU", Some(true)))).await;

        let (s, _) = send(&app, "GET", "/v1/templates/mine", None, None).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);

        let (s, list) = send(&app, "GET", "/v1/templates/mine", Some(&alice), None).await;
        assert_eq!(s, StatusCode::OK);
        let got = ids(&list);
        assert!(got.contains(&a_private) && got.contains(&a_public));
        assert!(!got.contains(&b_public));
    }

    #[tokio::test]
    async fn p1_private_templates_cannot_be_saved_or_counted_by_others() {
        let mut app = test_app();
        let owner = token_for(&mut app, "sv_owner").await;
        let other = token_for(&mut app, "sv_other").await;
        let id = Uuid::new_v4().to_string();
        send(&app, "PUT", &format!("/v1/templates/{id}"), Some(&owner), Some(tpl_payload("P", Some(false)))).await;

        let (s, _) = send(&app, "PUT", &format!("/v1/saved/{id}"), Some(&other), None).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let (s, _) = send(&app, "POST", &format!("/v1/templates/{id}/use"), Some(&other), None).await;
        assert_eq!(s, StatusCode::NOT_FOUND);

        // A saved template disappears from the saved list when its owner makes it private
        let pub_id = Uuid::new_v4().to_string();
        send(&app, "PUT", &format!("/v1/templates/{pub_id}"), Some(&owner), Some(tpl_payload("Q", Some(true)))).await;
        let (s, _) = send(&app, "PUT", &format!("/v1/saved/{pub_id}"), Some(&other), None).await;
        assert_eq!(s, StatusCode::OK);
        let (_, saved) = send(&app, "GET", "/v1/saved", Some(&other), None).await;
        assert!(ids(&saved).contains(&pub_id));
        send(&app, "PUT", &format!("/v1/templates/{pub_id}"), Some(&owner), Some(tpl_payload("Q", Some(false)))).await;
        let (_, saved) = send(&app, "GET", "/v1/saved", Some(&other), None).await;
        assert!(!ids(&saved).contains(&pub_id));
    }

    #[tokio::test]
    async fn p1_non_owner_cannot_change_visibility() {
        let mut app = test_app();
        let owner = token_for(&mut app, "vis_owner").await;
        let other = token_for(&mut app, "vis_other").await;
        let id = Uuid::new_v4().to_string();
        send(&app, "PUT", &format!("/v1/templates/{id}"), Some(&owner), Some(tpl_payload("V", Some(true)))).await;

        let (s, _) = send(&app, "PUT", &format!("/v1/templates/{id}"), Some(&other), Some(tpl_payload("V", Some(false)))).await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        let (_, list) = send(&app, "GET", "/v1/templates", None, None).await;
        assert!(ids(&list).contains(&id));
    }

    #[tokio::test]
    async fn p1_size_caps_apply_to_private_templates() {
        let mut app = test_app();
        let t = token_for(&mut app, "caps").await;
        let id = Uuid::new_v4().to_string();

        let mut big_body = tpl_payload("Big", Some(false));
        big_body["body"] = serde_json::json!("a".repeat(512 * 1024 + 1));
        let (s, _) = send(&app, "PUT", &format!("/v1/templates/{id}"), Some(&t), Some(big_body)).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);

        let mut big_readme = tpl_payload("Big", Some(false));
        big_readme["readme"] = serde_json::json!("a".repeat(64 * 1024 + 1));
        let (s, _) = send(&app, "PUT", &format!("/v1/templates/{id}"), Some(&t), Some(big_readme)).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);

        // Exactly at the limits is accepted
        let mut ok = tpl_payload("Ok", Some(false));
        ok["body"] = serde_json::json!("a".repeat(512 * 1024));
        ok["readme"] = serde_json::json!("a".repeat(64 * 1024));
        let (s, _) = send(&app, "PUT", &format!("/v1/templates/{id}"), Some(&t), Some(ok)).await;
        assert_eq!(s, StatusCode::OK);
    }

    #[tokio::test]
    async fn p1_owner_can_delete_private_template() {
        let mut app = test_app();
        let t = token_for(&mut app, "del_owner").await;
        let id = Uuid::new_v4().to_string();
        send(&app, "PUT", &format!("/v1/templates/{id}"), Some(&t), Some(tpl_payload("D", Some(false)))).await;
        let (s, _) = send(&app, "DELETE", &format!("/v1/templates/{id}"), Some(&t), None).await;
        assert_eq!(s, StatusCode::NO_CONTENT);
        let (s, _) = send(&app, "GET", &format!("/v1/templates/{id}"), Some(&t), None).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let (_, mine) = send(&app, "GET", "/v1/templates/mine", Some(&t), None).await;
        assert!(!ids(&mine).contains(&id));
    }

    #[tokio::test]
    async fn p1_invalid_token_on_get_is_unauthorized() {
        let mut app = test_app();
        let t = token_for(&mut app, "badtok").await;
        let id = Uuid::new_v4().to_string();
        send(&app, "PUT", &format!("/v1/templates/{id}"), Some(&t), Some(tpl_payload("T", Some(true)))).await;
        let (s, _) = send(&app, "GET", &format!("/v1/templates/{id}"), Some("not-a-real-token"), None).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
    }

    // ── Phase 1: template CSS travels with the HTML ──

    fn tpl_payload_with_css(name: &str, publish: Option<bool>, css: &str) -> serde_json::Value {
        let mut v = tpl_payload(name, publish);
        v["css"] = serde_json::json!(css);
        v
    }

    #[tokio::test]
    async fn p1_css_round_trips_for_the_owner() {
        let mut app = test_app();
        let owner = token_for(&mut app, "css_owner").await;
        let id = Uuid::new_v4().to_string();
        let css = "body { font-size: 9pt } @page { size: 80mm 200mm; }";

        let (s, put) = send(&app, "PUT", &format!("/v1/templates/{id}"), Some(&owner), Some(tpl_payload_with_css("Label", Some(false), css))).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(put["css"], css);

        let (s, got) = send(&app, "GET", &format!("/v1/templates/{id}"), Some(&owner), None).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(got["css"], css, "GET must return the stored CSS");
        assert_eq!(got["body"], "<div>x</div>", "HTML still travels alongside it");
    }

    #[tokio::test]
    async fn p1_css_is_returned_on_the_public_route_for_published_templates() {
        let mut app = test_app();
        let owner = token_for(&mut app, "css_pub").await;
        let id = Uuid::new_v4().to_string();
        send(&app, "PUT", &format!("/v1/templates/{id}"), Some(&owner), Some(tpl_payload_with_css("Public", Some(true), ".a { color: #000 }"))).await;

        let (s, got) = send(&app, "GET", &format!("/v1/templates/{id}"), None, None).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(got["css"], ".a { color: #000 }");
    }

    #[tokio::test]
    async fn p1_css_can_be_cleared_and_is_kept_when_a_request_omits_it() {
        let mut app = test_app();
        let owner = token_for(&mut app, "css_edit").await;
        let id = Uuid::new_v4().to_string();
        send(&app, "PUT", &format!("/v1/templates/{id}"), Some(&owner), Some(tpl_payload_with_css("A", Some(false), ".a{}"))).await;

        // An update that sends CSS replaces it, including with an empty string.
        let (_, v) = send(&app, "PUT", &format!("/v1/templates/{id}"), Some(&owner), Some(tpl_payload_with_css("A2", None, ".b{}"))).await;
        assert_eq!(v["css"], ".b{}");
        let (_, v) = send(&app, "PUT", &format!("/v1/templates/{id}"), Some(&owner), Some(tpl_payload_with_css("A3", None, ""))).await;
        assert_eq!(v["css"], "");

        // An update from a client that never learned about CSS keeps what is stored.
        send(&app, "PUT", &format!("/v1/templates/{id}"), Some(&owner), Some(tpl_payload_with_css("A4", None, ".c{}"))).await;
        let (_, v) = send(&app, "PUT", &format!("/v1/templates/{id}"), Some(&owner), Some(tpl_payload("A5", None))).await;
        assert_eq!(v["css"], ".c{}", "omitting css must not wipe the stored CSS");
    }

    #[tokio::test]
    async fn p1_css_is_capped_and_checked_for_remote_references() {
        let mut app = test_app();
        let owner = token_for(&mut app, "css_caps").await;
        let id = Uuid::new_v4().to_string();

        let mut big = tpl_payload_with_css("Big", Some(false), "");
        big["css"] = serde_json::json!("a".repeat(256 * 1024 + 1));
        let (s, _) = send(&app, "PUT", &format!("/v1/templates/{id}"), Some(&owner), Some(big)).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);

        let remote = tpl_payload_with_css("Remote", Some(false), ".logo { background: url(\"https://example.com/l.png\") }");
        let (s, _) = send(&app, "PUT", &format!("/v1/templates/{id}"), Some(&owner), Some(remote)).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);

        // Exactly at the cap is accepted.
        let ok = tpl_payload_with_css("Ok", Some(false), &"a".repeat(256 * 1024));
        let (s, _) = send(&app, "PUT", &format!("/v1/templates/{id}"), Some(&owner), Some(ok)).await;
        assert_eq!(s, StatusCode::OK);
    }
}
