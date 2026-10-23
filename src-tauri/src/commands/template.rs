use crate::db::DbState;
use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Template {
    pub id: i64,
    pub name: String,
    pub page_w_mm: i64,
    pub page_h_mm: i64,
    pub orientation: String,
    pub html: String,
    pub css: String,
    pub compiled_css: String,
    pub compiled_key: String,
    pub readme: String,
    pub summary: String,
    pub remote_id: Option<String>,
    pub server_id: Option<String>,
    pub published_at: Option<String>,
    pub origin: String,
    pub origin_owner: Option<String>,
    pub withdrawn: bool,
    /// The server revision this copy was last synced at. Saves send it
    /// as a guard; NULL means the server has never seen this row.
    pub base_revision: Option<i64>,
    /// `synced` | `dirty` | `deleted_pending` | `conflict`. A `dirty`
    /// row under the server-authoritative model is a draft: edits not
    /// yet saved to the server.
    pub sync_state: String,
    pub created_at: String,
    pub updated_at: String,
}

const VALID_ORIENTATIONS: &[&str] = &["portrait", "landscape"];

#[tauri::command]
pub fn list_templates(db: State<DbState>) -> AppResult<Vec<Template>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    let mut stmt = conn.prepare(
        "SELECT id, name, page_w_mm, page_h_mm,
                orientation, html, css, compiled_css, compiled_key,
                readme, summary, remote_id, server_id, published_at,
                origin, origin_owner, withdrawn, created_at, updated_at,
                base_revision, sync_state
         FROM templates WHERE sync_state <> 'deleted_pending'
         ORDER BY name COLLATE NOCASE",
    )?;

    let templates = stmt
        .query_map([], |row| {
            Ok(Template {
                id: row.get(0)?,
                name: row.get(1)?,
                page_w_mm: row.get(2)?,
                page_h_mm: row.get(3)?,
                orientation: row.get(4)?,
                html: row.get(5)?,
                css: row.get(6)?,
                compiled_css: row.get(7)?,
                compiled_key: row.get(8)?,
                readme: row.get(9)?,
                summary: row.get(10)?,
                remote_id: row.get(11)?,
                server_id: row.get(12)?,
                published_at: row.get(13)?,
                origin: row.get(14)?,
                origin_owner: row.get(15)?,
                withdrawn: row.get::<_, i64>(16)? != 0,
                created_at: row.get(17)?,
                updated_at: row.get(18)?,
                base_revision: row.get(19)?,
                sync_state: row.get(20)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(templates)
}

#[derive(Debug, Deserialize)]
pub struct CreateTemplateRequest {
    pub name: String,
    pub page_w_mm: Option<i64>,
    pub page_h_mm: Option<i64>,
    pub orientation: Option<String>,
    pub html: Option<String>,
    pub css: Option<String>,
    /// Tailwind CSS compiled from `html` by the frontend; see `TemplateVersion`.
    #[serde(default)]
    pub compiled_css: Option<String>,
    #[serde(default)]
    pub compiled_key: Option<String>,
    pub readme: Option<String>,
    pub summary: Option<String>,
    /// Sync bookkeeping (Phase 3). Absent means a brand-new local row:
    /// a fresh server id and `dirty` with no server copy. A download
    /// passes the server's id, revision and `synced` state instead.
    pub server_id: Option<String>,
    pub sync_state: Option<String>,
    pub kind: Option<String>,
    pub owner_handle: Option<String>,
    pub server_revision: Option<i64>,
    pub base_revision: Option<i64>,
}

#[tauri::command]
pub fn create_template(db: State<DbState>, req: CreateTemplateRequest) -> AppResult<Template> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    write_template(guard.connection(), &req)
}

/// The work behind [`create_template`], split out so the SQL runs in tests
/// against a real connection, without a Tauri app around it.
pub fn write_template(conn: &Connection, req: &CreateTemplateRequest) -> AppResult<Template> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("Template name required".into()));
    }

    let orientation = req
        .orientation
        .clone()
        .unwrap_or_else(|| "portrait".to_string());
    if !VALID_ORIENTATIONS.contains(&orientation.as_str()) {
        return Err(AppError::Validation(format!(
            "Invalid orientation '{}'. Expected one of {:?}",
            orientation, VALID_ORIENTATIONS
        )));
    }

    let page_w_mm = req.page_w_mm.unwrap_or(210);
    let page_h_mm = req.page_h_mm.unwrap_or(297);
    if page_w_mm <= 0 || page_h_mm <= 0 {
        return Err(AppError::Validation(
            "Page dimensions must be positive".into(),
        ));
    }

    let html = req.html.clone().unwrap_or_default();
    let css = req.css.clone().unwrap_or_default();
    if let Some(issues) = crate::render::handlebars::find_remote_refs(&html, &css) {
        return Err(AppError::Validation(format!(
            "Template contains remote references ({}). Use data: URIs instead.",
            issues.join("; ")
        )));
    }
    let readme = match req.readme.clone() {
        Some(r) if !r.trim().is_empty() => {
            crate::readme::validate_readme(&r)?;
            r
        }
        _ => crate::readme::readme_scaffold_with_placeholders(name, &html),
    };
    crate::readme::validate_readme(&readme)?;
    let summary = req.summary.clone().unwrap_or_default();

    let tx = conn.unchecked_transaction()?;

    let exists: i64 = tx.query_row(
        "SELECT COUNT(*) FROM templates WHERE name = ?1 COLLATE NOCASE AND sync_state <> 'deleted_pending'",
        [name],
        |r| r.get(0),
    )?;
    if exists > 0 {
        return Err(AppError::Validation(format!(
            "A template named '{}' already exists",
            name
        )));
    }

    // Sync bookkeeping (Phase 3): brand-new local rows are dirty with a
    // fresh server id; a download passes the server's id and revision
    // and starts synced.
    let sync_state = req
        .sync_state
        .clone()
        .unwrap_or_else(|| "dirty".to_string());
    if !["synced", "dirty", "deleted_pending", "conflict"].contains(&sync_state.as_str()) {
        return Err(AppError::Validation(format!(
            "Invalid sync_state '{sync_state}'"
        )));
    }
    let kind = req.kind.clone().unwrap_or_else(|| "own".to_string());
    if !["own", "saved"].contains(&kind.as_str()) {
        return Err(AppError::Validation(format!("Invalid kind '{kind}'")));
    }
    let server_id = req
        .server_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    tx.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation, html, css, compiled_css, compiled_key,
                readme, summary,
                server_id, server_revision, base_revision, sync_state, kind, owner_handle)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        rusqlite::params![
            name,
            page_w_mm,
            page_h_mm,
            orientation,
            html,
            css,
            req.compiled_css.clone().unwrap_or_default(),
            req.compiled_key.clone().unwrap_or_default(),
            readme,
            summary,
            server_id,
            req.server_revision,
            req.base_revision,
            sync_state,
            kind,
            req.owner_handle,
        ],
    )?;
    let template_id = tx.last_insert_rowid();

    tx.commit()?;

    let template = tx_guard_to_template(conn, template_id)?;
    Ok(template)
}

fn tx_guard_to_template(conn: &rusqlite::Connection, id: i64) -> rusqlite::Result<Template> {
    conn.query_row(
        "SELECT id, name, page_w_mm, page_h_mm,
                orientation, html, css, compiled_css, compiled_key,
                readme, summary, remote_id, server_id, published_at,
                origin, origin_owner, withdrawn, created_at, updated_at,
                base_revision, sync_state
         FROM templates WHERE id = ?1 AND sync_state <> 'deleted_pending'",
        [id],
        |row| {
            Ok(Template {
                id: row.get(0)?,
                name: row.get(1)?,
                page_w_mm: row.get(2)?,
                page_h_mm: row.get(3)?,
                orientation: row.get(4)?,
                html: row.get(5)?,
                css: row.get(6)?,
                compiled_css: row.get(7)?,
                compiled_key: row.get(8)?,
                readme: row.get(9)?,
                summary: row.get(10)?,
                remote_id: row.get(11)?,
                server_id: row.get(12)?,
                published_at: row.get(13)?,
                origin: row.get(14)?,
                origin_owner: row.get(15)?,
                withdrawn: row.get::<_, i64>(16)? != 0,
                created_at: row.get(17)?,
                updated_at: row.get(18)?,
                base_revision: row.get(19)?,
                sync_state: row.get(20)?,
            })
        },
    )
}

#[tauri::command]
pub fn get_template(db: State<DbState>, id: i64) -> AppResult<Template> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();
    tx_guard_to_template(conn, id).map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => {
            AppError::NotFound(format!("Template {} not found", id))
        }
        other => other.into(),
    })
}

#[derive(Debug, Deserialize)]
pub struct UpdateTemplateMetaRequest {
    pub id: i64,
    pub name: String,
    pub page_w_mm: i64,
    pub page_h_mm: i64,
    pub summary: Option<String>,
    pub html: Option<String>,
    pub css: Option<String>,
    pub compiled_css: Option<String>,
    pub compiled_key: Option<String>,
}

/// Writes a template's name, page size, summary and content. Refresh and Get from server
/// use it, because no other local command writes those fields (MIGRATION_PLAN.md
/// phase 1). Orientation follows the page size, as elsewhere in the app.
#[tauri::command]
pub fn update_template_meta(
    db: State<DbState>,
    req: UpdateTemplateMetaRequest,
) -> AppResult<Template> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();
    write_template_meta(conn, &req)
}

/// The work behind [`update_template_meta`], split out so the SQL runs in tests
/// against a real connection, without a Tauri app around it.
pub fn write_template_meta(
    conn: &rusqlite::Connection,
    req: &UpdateTemplateMetaRequest,
) -> AppResult<Template> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("Template name required".into()));
    }
    if req.page_w_mm <= 0 || req.page_h_mm <= 0 {
        return Err(AppError::Validation(
            "Page dimensions must be positive".into(),
        ));
    }
    let orientation = if req.page_w_mm > req.page_h_mm {
        "landscape"
    } else {
        "portrait"
    };

    // Content fields are optional so old callers (meta-only updates) keep
    // working; when present they overwrite the row's content directly.
    let current: (String, String, String, String) = conn
        .query_row(
            "SELECT html, css, compiled_css, compiled_key FROM templates WHERE id = ?1",
            [req.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|_| AppError::NotFound(format!("Template {} not found", req.id)))?;
    let html = req.html.clone().unwrap_or(current.0);
    let css = req.css.clone().unwrap_or(current.1);
    let compiled_css = req.compiled_css.clone().unwrap_or(current.2);
    let compiled_key = req.compiled_key.clone().unwrap_or(current.3);
    if let Some(issues) = crate::render::handlebars::find_remote_refs(&html, &css) {
        return Err(AppError::Validation(format!(
            "Template contains remote references ({}). Use data: URIs instead.",
            issues.join("; ")
        )));
    }

    let affected = conn.execute(
        "UPDATE templates SET name = ?1, page_w_mm = ?2, page_h_mm = ?3, orientation = ?4,
             summary = ?5, html = ?6, css = ?7, compiled_css = ?8, compiled_key = ?9,
             updated_at = datetime('now'),
             sync_state = CASE WHEN sync_state = 'deleted_pending' THEN 'deleted_pending' ELSE 'dirty' END
         WHERE id = ?10",
        rusqlite::params![
            name,
            req.page_w_mm,
            req.page_h_mm,
            orientation,
            req.summary.clone().unwrap_or_default(),
            html,
            css,
            compiled_css,
            compiled_key,
            req.id
        ],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("Template {} not found", req.id)));
    }
    tx_guard_to_template(conn, req.id).map_err(Into::into)
}

#[derive(Debug, Deserialize)]
pub struct UpdateReadmeRequest {
    pub id: i64,
    pub readme: String,
}

#[tauri::command]
pub fn update_readme(db: State<DbState>, req: UpdateReadmeRequest) -> AppResult<Template> {
    crate::readme::validate_readme(&req.readme)?;
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();
    let affected = conn.execute(
        "UPDATE templates SET readme = ?1, updated_at = datetime('now'),
                sync_state = CASE WHEN sync_state = 'deleted_pending' THEN 'deleted_pending' ELSE 'dirty' END
         WHERE id = ?2",
        rusqlite::params![req.readme, req.id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("Template {} not found", req.id)));
    }
    tx_guard_to_template(conn, req.id).map_err(Into::into)
}

#[tauri::command]
pub fn delete_template(db: State<DbState>, id: i64) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    write_delete_template(guard.connection(), id)
}

/// Soft delete: the row becomes a local tombstone the sync engine
/// confirms against the server before it is really removed. Reads filter
/// deleted_pending rows out, so the app stops seeing the template at once.
pub fn write_delete_template(conn: &Connection, id: i64) -> AppResult<()> {
    let affected = conn.execute(
        "UPDATE templates SET sync_state = 'deleted_pending' WHERE id = ?1 AND sync_state <> 'deleted_pending'",
        [id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("Template {} not found", id)));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct SetPublishInfoRequest {
    pub id: i64,
    pub remote_id: String,
    /// `None` links the template to the server and leaves it private.
    pub published_at: Option<String>,
}

#[tauri::command]
pub fn set_publish_info(db: State<DbState>, req: SetPublishInfoRequest) -> AppResult<Template> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();
    write_publish_info(conn, &req)
}

/// The work behind [`set_publish_info`], split out for tests.
pub fn write_publish_info(
    conn: &rusqlite::Connection,
    req: &SetPublishInfoRequest,
) -> AppResult<Template> {
    // Validate UUID
    if uuid::Uuid::parse_str(&req.remote_id).is_err() {
        return Err(AppError::Validation(
            "Invalid remote_id (must be UUID)".into(),
        ));
    }
    // A null `published_at` links the template to the server without publishing it:
    // the row is private, and `updated_at` records when it was last touched. Any other
    // value is the moment the copy on the server was published, and marks this row as
    // being in step with it.
    let affected = conn.execute(
        "UPDATE templates SET remote_id = ?1, published_at = ?2,
             updated_at = COALESCE(?2, datetime('now')) WHERE id = ?3",
        rusqlite::params![req.remote_id, req.published_at, req.id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("Template {} not found", req.id)));
    }
    tx_guard_to_template(conn, req.id).map_err(Into::into)
}

#[derive(Debug, Deserialize)]
pub struct ClearPublishInfoRequest {
    pub id: i64,
}

#[tauri::command]
pub fn clear_publish_info(db: State<DbState>, req: ClearPublishInfoRequest) -> AppResult<Template> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();
    let affected = conn.execute(
        "UPDATE templates SET remote_id = NULL, published_at = NULL WHERE id = ?1",
        [req.id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("Template {} not found", req.id)));
    }
    tx_guard_to_template(conn, req.id).map_err(Into::into)
}

#[derive(Debug, Deserialize)]
pub struct UpdateOriginRequest {
    pub id: i64,
    pub origin: String,
    pub origin_owner: Option<String>,
}

#[tauri::command]
pub fn update_template_origin(db: State<DbState>, req: UpdateOriginRequest) -> AppResult<Template> {
    if req.origin != "own" && req.origin != "saved" {
        return Err(AppError::Validation(
            "origin must be 'own' or 'saved'".into(),
        ));
    }
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();
    let affected = conn.execute(
        "UPDATE templates SET origin = ?1, origin_owner = ?2 WHERE id = ?3",
        rusqlite::params![req.origin, req.origin_owner, req.id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("Template {} not found", req.id)));
    }
    tx_guard_to_template(conn, req.id).map_err(Into::into)
}
