use crate::db::DbState;
use crate::error::{AppError, AppResult};
use crate::queue::PrintQueue;
use rusqlite::Connection;
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

// The command bodies live in `*_conn` functions that take the shared
// connection, so integration tests can call them directly — the IPC wrappers
// only take the lock (Phase 0: P1's `WHERE`-after-`ORDER BY` bug survived
// because no test could reach these functions).

#[tauri::command]
pub fn list_jobs(db: State<DbState>) -> AppResult<Vec<PrintJob>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    list_jobs_conn(guard.connection())
}

#[tauri::command]
pub fn get_job(db: State<DbState>, id: i64) -> AppResult<PrintJob> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    get_job_conn(guard.connection(), id)
}

#[tauri::command]
pub fn reprint_job(db: State<DbState>, queue: State<PrintQueue>, id: i64) -> AppResult<PrintJob> {
    let job = {
        let guard = db
            .lock()
            .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
        reprint_job_conn(guard.connection(), id)?
    };
    // The clone is a `queued` row; wake the worker that prints it (P3).
    queue.kick();
    Ok(job)
}

#[tauri::command]
pub fn retry_job(db: State<DbState>, queue: State<PrintQueue>, id: i64) -> AppResult<PrintJob> {
    let job = {
        let guard = db
            .lock()
            .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
        retry_job_conn(guard.connection(), id)?
    };
    // The row is `queued` again; wake the worker that prints it (P3).
    queue.kick();
    Ok(job)
}

#[tauri::command]
pub fn delete_job(db: State<DbState>, id: i64) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    delete_job_conn(guard.connection(), id)
}

pub fn list_jobs_conn(conn: &Connection) -> AppResult<Vec<PrintJob>> {
    // ORDER BY lives here, not in the shared column list: `get_job`,
    // `reprint_job` and `retry_job` append `WHERE id = ?1`, which after an
    // `ORDER BY` is a syntax error (P1).
    let sql = format!("{} ORDER BY id DESC", SELECT_JOB_COLUMNS);
    let mut stmt = conn.prepare(&sql)?;
    let jobs = stmt
        .query_map([], map_job)?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(jobs)
}

pub fn get_job_conn(conn: &Connection, id: i64) -> AppResult<PrintJob> {
    let sql = format!("{} WHERE id = ?1", SELECT_JOB_COLUMNS);
    conn.query_row(&sql, [id], map_job).map_err(|e| match e {
        // Consistent with retry_job/delete_job and the REST 404 (P1 follow-up).
        rusqlite::Error::QueryReturnedNoRows => AppError::NotFound(format!("Job {} not found", id)),
        other => other.into(),
    })
}

pub fn reprint_job_conn(conn: &Connection, id: i64) -> AppResult<PrintJob> {
    // Reprint must clone the ORIGINAL job so the exact template version,
    // settings and copies are reproduced (PLANNING.md 4). Read the original
    // first: a missing one is a 404, and `INSERT .. SELECT` with no row
    // would otherwise silently clone nothing.
    let sql = format!("{} WHERE id = ?1", SELECT_JOB_COLUMNS);
    let _original = conn.query_row(&sql, [id], map_job).map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => AppError::NotFound(format!("Job {} not found", id)),
        other => other.into(),
    })?;

    // Clone the row itself — including its stored input payload
    // (`data_json`), which the worker replays when it prints the clone
    // (P3). The fresh row is `queued`; nothing but the worker prints it.
    conn.execute(
        "INSERT INTO print_jobs
            (batch_id, record_index, template_id, template_version_id, printer_id,
             source, source_url, status, error, copies, settings_json, rendered_html,
             idempotency_key, is_test, data_json)
         SELECT NULL, NULL, template_id, template_version_id, printer_id,
                source, source_url, 'queued', NULL, copies, settings_json, rendered_html,
                NULL, is_test, data_json
         FROM print_jobs WHERE id = ?1",
        [id],
    )?;

    let new_id = conn.last_insert_rowid();
    let sql = format!("{} WHERE id = ?1", SELECT_JOB_COLUMNS);
    Ok(conn.query_row(&sql, [new_id], map_job)?)
}

pub fn retry_job_conn(conn: &Connection, id: i64) -> AppResult<PrintJob> {
    let exists: i64 =
        conn.query_row("SELECT COUNT(*) FROM print_jobs WHERE id = ?1", [id], |r| {
            r.get(0)
        })?;
    if exists == 0 {
        return Err(AppError::NotFound(format!("Job {} not found", id)));
    }

    // Only a terminal row may be re-queued. Re-queuing a `printing` row
    // would let the worker claim it while the direct pipeline still runs
    // it — one physical print for two owners — and re-queuing a `queued`
    // row would print it twice. A finished row reprints instead (P3).
    let affected = conn.execute(
        "UPDATE print_jobs
         SET status = 'queued', error = NULL, started_at = NULL,
             finished_at = NULL, duration_ms = NULL
         WHERE id = ?1 AND status IN ('failed', 'cancelled')",
        [id],
    )?;
    if affected == 0 {
        return Err(AppError::Validation(
            "Only a failed or cancelled job can be retried; a finished job reprints instead".into(),
        ));
    }

    let sql = format!("{} WHERE id = ?1", SELECT_JOB_COLUMNS);
    Ok(conn.query_row(&sql, [id], map_job)?)
}

pub fn delete_job_conn(conn: &Connection, id: i64) -> AppResult<()> {
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
     FROM print_jobs";

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
