use crate::db::DbState;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrintJob {
    pub id: i64,
    pub batch_id: Option<i64>,
    pub record_index: Option<i64>,
    pub template_id: Option<i64>,
    pub template_version_id: Option<i64>,
    pub printer_id: Option<i64>,
    pub source: String,
    pub source_url: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub copies: i64,
    pub settings_json: Option<String>,
    pub rendered_html: Option<String>,
    pub idempotency_key: Option<String>,
    pub is_test: bool,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
}

#[tauri::command]
pub fn list_jobs(db: State<DbState>) -> AppResult<Vec<PrintJob>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection()?;

    let mut stmt = conn.prepare(SELECT_JOB_COLUMNS)?;
    let jobs = stmt
        .query_map([], map_job)?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(jobs)
}

#[tauri::command]
pub fn get_job(db: State<DbState>, id: i64) -> AppResult<PrintJob> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection()?;

    let sql = format!("{} WHERE id = ?1", SELECT_JOB_COLUMNS);
    let job = conn.query_row(&sql, [id], map_job)?;

    Ok(job)
}

#[tauri::command]
pub fn reprint_job(db: State<DbState>, id: i64) -> AppResult<PrintJob> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection()?;

    // Reprint must clone the ORIGINAL job so the exact template version,
    // settings and copies are reproduced (PLANNING.md 4).
    let sql = format!("{} WHERE id = ?1", SELECT_JOB_COLUMNS);
    let original = conn.query_row(&sql, [id], map_job)?;

    conn.execute(
        "INSERT INTO print_jobs
           (batch_id, record_index, template_id, template_version_id, printer_id,
            source, source_url, status, error, copies, settings_json, rendered_html,
            idempotency_key, is_test)
         VALUES (NULL, NULL, ?1, ?2, ?3, ?4, ?5, 'queued', NULL, ?6, ?7, ?8, NULL, ?9)",
        rusqlite::params![
            original.template_id,
            original.template_version_id,
            original.printer_id,
            original.source,
            original.source_url,
            original.copies,
            original.settings_json,
            original.rendered_html,
            original.is_test,
        ],
    )?;

    let new_id = conn.last_insert_rowid();
    let sql = format!("{} WHERE id = ?1", SELECT_JOB_COLUMNS);
    Ok(conn.query_row(&sql, [new_id], map_job)?)
}

#[tauri::command]
pub fn retry_job(db: State<DbState>, id: i64) -> AppResult<PrintJob> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection()?;

    let exists: i64 =
        conn.query_row("SELECT COUNT(*) FROM print_jobs WHERE id = ?1", [id], |r| {
            r.get(0)
        })?;
    if exists == 0 {
        return Err(AppError::NotFound(format!("Job {} not found", id)));
    }

    conn.execute(
        "UPDATE print_jobs
         SET status = 'queued', error = NULL, started_at = NULL,
             finished_at = NULL, duration_ms = NULL
         WHERE id = ?1",
        [id],
    )?;

    let sql = format!("{} WHERE id = ?1", SELECT_JOB_COLUMNS);
    Ok(conn.query_row(&sql, [id], map_job)?)
}

#[tauri::command]
pub fn delete_job(db: State<DbState>, id: i64) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection()?;

    let affected = conn.execute("DELETE FROM print_jobs WHERE id = ?1", [id])?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("Job {} not found", id)));
    }
    Ok(())
}

const SELECT_JOB_COLUMNS: &str = "SELECT id, batch_id, record_index, template_id,
            template_version_id, printer_id, source, source_url, status, error,
            copies, settings_json, rendered_html, idempotency_key, is_test,
            started_at, finished_at, duration_ms
     FROM print_jobs
     ORDER BY id DESC";

fn map_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<PrintJob> {
    Ok(PrintJob {
        id: row.get(0)?,
        batch_id: row.get(1)?,
        record_index: row.get(2)?,
        template_id: row.get(3)?,
        template_version_id: row.get(4)?,
        printer_id: row.get(5)?,
        source: row.get(6)?,
        source_url: row.get(7)?,
        status: row.get(8)?,
        error: row.get(9)?,
        copies: row.get(10)?,
        settings_json: row.get(11)?,
        rendered_html: row.get(12)?,
        idempotency_key: row.get(13)?,
        is_test: row.get(14)?,
        started_at: row.get(15)?,
        finished_at: row.get(16)?,
        duration_ms: row.get(17)?,
    })
}
