use crate::db::DbState;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateVersion {
    pub id: i64,
    pub template_id: i64,
    pub version_no: i64,
    pub html: String,
    pub css: String,
    pub label: Option<String>,
    pub note: Option<String>,
    pub created_at: String,
    pub created_by: String,
    /// Tailwind CSS compiled from this version's HTML, or empty when it has
    /// not been compiled (printing then uses the shared bundle).
    #[serde(default)]
    pub compiled_css: String,
    /// Class-set hash plus compiler revision the stylesheet was built from.
    #[serde(default)]
    pub compiled_key: String,
}

const VERSION_COLUMNS: &str =
    "id, template_id, version_no, html, css, label, note, created_at, created_by, compiled_css, compiled_key";

fn map_version(row: &rusqlite::Row) -> rusqlite::Result<TemplateVersion> {
    Ok(TemplateVersion {
        id: row.get(0)?,
        template_id: row.get(1)?,
        version_no: row.get(2)?,
        html: row.get(3)?,
        css: row.get(4)?,
        label: row.get(5)?,
        note: row.get(6)?,
        created_at: row.get(7)?,
        created_by: row.get(8)?,
        compiled_css: row.get(9)?,
        compiled_key: row.get(10)?,
    })
}

/// `sync` marks the version a Refresh from the server produced, so history
/// shows which copy came from where.
const VALID_CREATED_BY: &[&str] = &["manual", "autosave", "restore", "sync"];

#[tauri::command]
pub fn list_versions(db: State<DbState>, template_id: i64) -> AppResult<Vec<TemplateVersion>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection()?;

    let mut stmt = conn.prepare(
        &format!("SELECT {VERSION_COLUMNS} FROM template_versions WHERE template_id = ?1 ORDER BY version_no DESC"),
    )?;

    let versions = stmt
        .query_map([template_id], map_version)?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(versions)
}

#[derive(Debug, Deserialize)]
pub struct CreateVersionRequest {
    pub template_id: i64,
    pub html: String,
    pub css: String,
    pub label: Option<String>,
    pub note: Option<String>,
    pub created_by: Option<String>,
    #[serde(default)]
    pub compiled_css: Option<String>,
    #[serde(default)]
    pub compiled_key: Option<String>,
}

#[tauri::command]
pub fn create_version(db: State<DbState>, req: CreateVersionRequest) -> AppResult<TemplateVersion> {
    let created_by = req.created_by.unwrap_or_else(|| "manual".to_string());
    if !VALID_CREATED_BY.contains(&created_by.as_str()) {
        return Err(AppError::Validation(format!(
            "Invalid created_by '{}'. Expected one of {:?}",
            created_by, VALID_CREATED_BY
        )));
    }
    if let Some(issues) = crate::render::handlebars::find_remote_refs(&req.html, &req.css) {
        return Err(AppError::Validation(format!(
            "Template contains remote references ({}). Use data: URIs instead.",
            issues.join("; ")
        )));
    }

    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let mut conn = guard.connection()?;
    let tx = conn.transaction()?;

    let template_exists: i64 = tx.query_row(
        "SELECT COUNT(*) FROM templates WHERE id = ?1",
        [req.template_id],
        |r| r.get(0),
    )?;
    if template_exists == 0 {
        return Err(AppError::NotFound(format!(
            "Template {} not found",
            req.template_id
        )));
    }

    let next_no: i64 = tx.query_row(
        "SELECT COALESCE(MAX(version_no), 0) + 1 FROM template_versions WHERE template_id = ?1",
        [req.template_id],
        |r| r.get(0),
    )?;

    tx.execute(
        "INSERT INTO template_versions
           (template_id, version_no, html, css, label, note, created_by,
            compiled_css, compiled_key)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            req.template_id,
            next_no,
            req.html,
            req.css,
            req.label,
            req.note,
            created_by,
            req.compiled_css.unwrap_or_default(),
            req.compiled_key.unwrap_or_default(),
        ],
    )?;
    let version_id = tx.last_insert_rowid();

    tx.execute(
        "UPDATE templates SET current_version_id = ?1, updated_at = datetime('now')
         WHERE id = ?2",
        rusqlite::params![version_id, req.template_id],
    )?;

    tx.commit()?;

    let version = conn.query_row(
        &format!("SELECT {VERSION_COLUMNS} FROM template_versions WHERE id = ?1"),
        [version_id],
        map_version,
    )?;

    Ok(version)
}

#[derive(Debug, Deserialize)]
pub struct SetCompiledCssRequest {
    pub id: i64,
    pub compiled_css: String,
    pub compiled_key: String,
}

/// Store the Tailwind CSS compiled from a version's HTML.
///
/// This is a cache of a pure function of `html`, so it deliberately leaves
/// history alone: no new version, and `updated_at` and `current_version_id`
/// stay as they are (the "changes not saved" badge compares `updated_at`).
/// The frontend calls it at startup for versions that were saved before
/// compilation existed, or by an older compiler revision.
#[tauri::command]
pub fn set_version_compiled_css(db: State<DbState>, req: SetCompiledCssRequest) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection()?;
    let affected = conn.execute(
        "UPDATE template_versions SET compiled_css = ?1, compiled_key = ?2 WHERE id = ?3",
        rusqlite::params![req.compiled_css, req.compiled_key, req.id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("Version {} not found", req.id)));
    }
    Ok(())
}

/// Restore must never overwrite history (PLANNING.md 7.3):
/// it creates a NEW version whose content matches the old one.
#[tauri::command]
pub fn restore_version(db: State<DbState>, id: i64) -> AppResult<TemplateVersion> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let mut conn = guard.connection()?;
    let tx = conn.transaction()?;

    let (template_id, html, css, compiled_css, compiled_key): (
        i64,
        String,
        String,
        String,
        String,
    ) = tx.query_row(
        "SELECT template_id, html, css, compiled_css, compiled_key
             FROM template_versions WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;

    let next_no: i64 = tx.query_row(
        "SELECT COALESCE(MAX(version_no), 0) + 1 FROM template_versions WHERE template_id = ?1",
        [template_id],
        |r| r.get(0),
    )?;

    tx.execute(
        "INSERT INTO template_versions
           (template_id, version_no, html, css, label, note, created_by,
            compiled_css, compiled_key)
         VALUES (?1, ?2, ?3, ?4, 'Restored', ?5, 'restore', ?6, ?7)",
        rusqlite::params![
            template_id,
            next_no,
            html,
            css,
            format!("restored from version id {}", id),
            compiled_css,
            compiled_key,
        ],
    )?;
    let new_id = tx.last_insert_rowid();

    tx.execute(
        "UPDATE templates SET current_version_id = ?1, updated_at = datetime('now')
         WHERE id = ?2",
        rusqlite::params![new_id, template_id],
    )?;

    tx.commit()?;

    let version = conn.query_row(
        &format!("SELECT {VERSION_COLUMNS} FROM template_versions WHERE id = ?1"),
        [new_id],
        map_version,
    )?;

    Ok(version)
}

#[tauri::command]
pub fn delete_version(db: State<DbState>, id: i64) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection()?;

    let affected = conn.execute("DELETE FROM template_versions WHERE id = ?1", [id])?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("Version {} not found", id)));
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct VersionDiff {
    pub from_id: i64,
    pub to_id: i64,
    pub from_version_no: i64,
    pub to_version_no: i64,
    pub html_from: String,
    pub html_to: String,
    pub css_from: String,
    pub css_to: String,
    pub html_changed: bool,
    pub css_changed: bool,
}

/// Line-level diff of any two versions of the same template (PLANNING.md 7.3).
#[tauri::command]
pub fn diff_versions(db: State<DbState>, from_id: i64, to_id: i64) -> AppResult<VersionDiff> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection()?;

    let load = |id: i64| -> rusqlite::Result<(i64, i64, String, String)> {
        conn.query_row(
            "SELECT template_id, version_no, html, css
             FROM template_versions WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
    };

    let (t_from, n_from, html_from, css_from) =
        load(from_id).map_err(|_| AppError::NotFound(format!("Version {} not found", from_id)))?;
    let (t_to, n_to, html_to, css_to) =
        load(to_id).map_err(|_| AppError::NotFound(format!("Version {} not found", to_id)))?;

    if t_from != t_to {
        return Err(AppError::Validation(
            "Cannot diff versions from different templates".into(),
        ));
    }

    Ok(VersionDiff {
        from_id,
        to_id,
        from_version_no: n_from,
        to_version_no: n_to,
        html_changed: html_from != html_to,
        css_changed: css_from != css_to,
        html_from,
        html_to,
        css_from,
        css_to,
    })
}
