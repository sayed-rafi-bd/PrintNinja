use crate::db::DbState;
use crate::error::{AppError, AppResult};
use crate::queue::PrintQueue;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Batch {
    pub id: i64,
    pub template_id: Option<i64>,
    pub printer_id: Option<i64>,
    pub total: i64,
    pub done: i64,
    pub failed: i64,
    pub mode: String,
    pub status: String,
    pub created_at: String,
}

const VALID_MODES: &[&str] = &["per_record"];
/// Same cap the REST `POST /v1/print/batch` applies to `data` (P3).
pub const DEFAULT_MAX_RECORDS: usize = 5000;

#[derive(Debug, Deserialize)]
pub struct CreateBatchRequest {
    pub template_id: i64,
    pub printer_id: i64,
    pub data: serde_json::Value,
    pub mode: String,
    pub settings_json: Option<String>,
    pub stop_on_error: Option<bool>,
}

#[tauri::command]
pub fn create_batch(
    db: State<DbState>,
    queue: State<PrintQueue>,
    req: CreateBatchRequest,
) -> AppResult<Batch> {
    let batch = {
        let guard = db
            .lock()
            .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
        create_batch_conn(guard.connection(), req)?
    };
    // The rows are `queued`; wake the worker that prints them (P3).
    queue.kick();
    Ok(batch)
}

/// The command body on a borrowed connection — the real insert path, so
/// integration tests can drive what the worker consumes (Phase 0, P3).
pub fn create_batch_conn(conn: &Connection, req: CreateBatchRequest) -> AppResult<Batch> {
    if !VALID_MODES.contains(&req.mode.as_str()) {
        return Err(AppError::Validation(format!(
            "Invalid mode '{}'. Expected one of {:?}",
            req.mode, VALID_MODES
        )));
    }

    let records = req
        .data
        .as_array()
        .ok_or_else(|| AppError::Validation("Batch data must be a JSON array".into()))?;

    if records.is_empty() {
        return Err(AppError::Validation("Batch contains no records".into()));
    }
    if records.len() > DEFAULT_MAX_RECORDS {
        return Err(AppError::Validation(format!(
            "Batch too large: {} records (max {})",
            records.len(),
            DEFAULT_MAX_RECORDS
        )));
    }

    let settings = req.settings_json.unwrap_or_else(|| "{}".into());
    serde_json::from_str::<serde_json::Value>(&settings)
        .map_err(|e| AppError::Validation(format!("Invalid settings JSON: {}", e)))?;

    let tx = conn.unchecked_transaction()?;

    // Validate references so a batch never points at a missing printer/template.
    for (id, table) in [(req.printer_id, "printers"), (req.template_id, "templates")] {
        let n: i64 = tx.query_row(
            &format!("SELECT COUNT(*) FROM {} WHERE id = ?1", table),
            [id],
            |r| r.get(0),
        )?;
        if n == 0 {
            return Err(AppError::NotFound(format!(
                "{} {} not found",
                table.trim_end_matches('s'),
                id
            )));
        }
    }

    tx.execute(
        "INSERT INTO batches (template_id, printer_id, total, mode, status)
         VALUES (?1, ?2, ?3, ?4, 'queued')",
        rusqlite::params![
            req.template_id,
            req.printer_id,
            records.len() as i64,
            req.mode
        ],
    )?;
    let batch_id = tx.last_insert_rowid();

    match req.mode.as_str() {
        "per_record" => {
            // One queued job per record (PLANNING.md 7.8: best for thermal).
            // Each record's own payload rides on its row in `data_json` —
            // without it the worker would have nothing to render (P3).
            for (idx, record) in records.iter().enumerate() {
                tx.execute(
                    "INSERT INTO print_jobs
                       (batch_id, record_index, template_id,
                        printer_id, source, status, copies, settings_json, is_test, data_json)
                     VALUES (?1, ?2, ?3, ?4, 'batch', 'queued', 1, ?5, 0, ?6)",
                    rusqlite::params![
                        batch_id,
                        idx as i64,
                        req.template_id,
                        req.printer_id,
                        settings,
                        record.to_string(),
                    ],
                )?;
            }
        }
        _ => {
            return Err(AppError::Validation(
                "unsupported batch mode: only 'per_record' is supported".into(),
            ));
        }
    }

    tx.commit()?;

    let batch = tx_guard_to_batch(conn, batch_id)?;
    Ok(batch)
}

fn tx_guard_to_batch(conn: &rusqlite::Connection, id: i64) -> rusqlite::Result<Batch> {
    conn.query_row(
        "SELECT id, template_id, printer_id, total, done, failed, mode, status, created_at
         FROM batches WHERE id = ?1",
        [id],
        |row| {
            Ok(Batch {
                id: row.get(0)?,
                template_id: row.get(1)?,
                printer_id: row.get(2)?,
                total: row.get(3)?,
                done: row.get(4)?,
                failed: row.get(5)?,
                mode: row.get(6)?,
                status: row.get(7)?,
                created_at: row.get(8)?,
            })
        },
    )
}

#[tauri::command]
pub fn list_batches(db: State<DbState>) -> AppResult<Vec<Batch>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    let mut stmt = conn.prepare(
        "SELECT id, template_id, printer_id, total, done, failed, mode, status, created_at
         FROM batches ORDER BY id DESC",
    )?;

    let batches = stmt
        .query_map([], |row| {
            Ok(Batch {
                id: row.get(0)?,
                template_id: row.get(1)?,
                printer_id: row.get(2)?,
                total: row.get(3)?,
                done: row.get(4)?,
                failed: row.get(5)?,
                mode: row.get(6)?,
                status: row.get(7)?,
                created_at: row.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(batches)
}

#[tauri::command]
pub fn get_batch(db: State<DbState>, id: i64) -> AppResult<Batch> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    tx_guard_to_batch(conn, id).map_err(|_| AppError::NotFound(format!("Batch {} not found", id)))
}

#[tauri::command]
pub fn cancel_batch(db: State<DbState>, id: i64) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();
    let tx = conn.unchecked_transaction()?;

    let n: i64 = tx.query_row("SELECT COUNT(*) FROM batches WHERE id = ?1", [id], |r| {
        r.get(0)
    })?;
    if n == 0 {
        return Err(AppError::NotFound(format!("Batch {} not found", id)));
    }

    // Cancel every job that has not started yet. A batch that already has
    // a job in flight (`printing`) is cancellable too: its queued rows
    // leave the queue, the running job ends on its own, and the batch keeps
    // `cancelled` — the worker's counter update guards `status !=
    // 'cancelled'`, so finished jobs cannot resurrect it.
    let affected = tx.execute(
        "UPDATE batches SET status = 'cancelled'
         WHERE id = ?1 AND status IN ('queued', 'printing')",
        [id],
    )?;

    tx.execute(
        "UPDATE print_jobs SET status = 'cancelled'
         WHERE batch_id = ?1 AND status = 'queued'",
        [id],
    )?;

    tx.commit()?;

    if affected == 0 {
        return Err(AppError::Validation(
            "Batch is not cancellable (already finished)".into(),
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn retry_batch(db: State<DbState>, queue: State<PrintQueue>, id: i64) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();
    let tx = conn.unchecked_transaction()?;

    let n: i64 = tx.query_row("SELECT COUNT(*) FROM batches WHERE id = ?1", [id], |r| {
        r.get(0)
    })?;
    if n == 0 {
        return Err(AppError::NotFound(format!("Batch {} not found", id)));
    }

    // Only failed records are retried; successes are left alone.
    tx.execute(
        "UPDATE print_jobs
         SET status = 'queued', error = NULL, started_at = NULL,
             finished_at = NULL, duration_ms = NULL, timings_json = NULL
         WHERE batch_id = ?1 AND status IN ('failed', 'cancelled')",
        [id],
    )?;

    tx.execute(
        "UPDATE batches
         SET status = 'queued', failed = 0, done = (
             SELECT COUNT(*) FROM print_jobs
             WHERE batch_id = ?1 AND status = 'success'
         )
         WHERE id = ?1",
        [id],
    )?;

    tx.commit()?;

    // The re-queued rows are `queued`; wake the worker that prints them (P3).
    queue.kick();
    Ok(())
}
