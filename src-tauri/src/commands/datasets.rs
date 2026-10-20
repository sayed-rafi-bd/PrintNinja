//! Sample datasets for the Designer's sample-data panel (Phase 4).
//!
//! Account-level named JSON blobs, synced like templates: the Designer
//! reads `list_datasets`, saves through `save_dataset` and deletes
//! through `delete_dataset`, and every mutation is a cache write (dirty
//! or tombstoned) the sync engine moves. The read path for a fresh PC is
//! the sync stream, not a list endpoint.

use crate::db::DbState;
use crate::error::{AppError, AppResult};
use rusqlite::{Connection, Transaction};
use serde::{Deserialize, Serialize};
use tauri::State;

/// A synced dataset row, as the app and the engine see it.
#[derive(Debug, Clone, Serialize)]
pub struct SyncedDataset {
    pub id: i64,
    pub server_id: String,
    pub name: String,
    pub data_json: String,
    pub server_revision: Option<i64>,
    pub base_revision: Option<i64>,
    pub sync_state: String,
    pub created_at: String,
    pub updated_at: String,
}

/// One record from a sync upsert. Field names match the wire shape.
#[derive(Debug, Clone, Deserialize)]
pub struct DatasetDataIn {
    pub id: String,
    pub name: String,
    pub data_json: String,
    pub revision: i64,
}

/// A row waiting to be pushed: everything the PUT needs plus the base
/// revision the next push must send as `if_revision` (null for rows that
/// never reached the server).
#[derive(Debug, Clone, Serialize)]
pub struct DirtyDataset {
    pub server_id: String,
    pub name: String,
    pub data_json: String,
    pub base_revision: Option<i64>,
}

/// Bodies are capped like the server (256 KiB); unchecked TEXT length
/// would let multi-byte text past the budget.
pub const DATASET_JSON_MAX_BYTES: usize = 262_144;

fn check_write(name: &str, data_json: &str) -> AppResult<(String, String)> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Validation("Dataset name required".into()));
    }
    if data_json.len() > DATASET_JSON_MAX_BYTES {
        return Err(AppError::Validation(format!(
            "Dataset is over the {DATASET_JSON_MAX_BYTES} byte cap"
        )));
    }
    serde_json::from_str::<serde_json::Value>(data_json)
        .map_err(|e| AppError::Validation(format!("Dataset is not valid JSON: {e}")))?;
    Ok((name, data_json.to_string()))
}

fn row_to_dataset(row: &rusqlite::Row) -> rusqlite::Result<SyncedDataset> {
    Ok(SyncedDataset {
        id: row.get(0)?,
        server_id: row.get(1)?,
        name: row.get(2)?,
        data_json: row.get(3)?,
        server_revision: row.get(4)?,
        base_revision: row.get(5)?,
        sync_state: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

const SELECT_COLS: &str = "id, server_id, name, data_json, server_revision, base_revision, sync_state, created_at, updated_at";

pub fn query_datasets(conn: &Connection) -> AppResult<Vec<SyncedDataset>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLS} FROM synced_datasets ORDER BY name COLLATE NOCASE"
    ))?;
    let rows = stmt
        .query_map([], row_to_dataset)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[derive(Debug, Deserialize)]
pub struct SaveDatasetRequest {
    pub id: Option<i64>,
    pub name: String,
    pub data_json: String,
}

/// Creates or updates a dataset. Both paths mark the row dirty; the
/// engine pushes it and records the server revision.
pub fn store_dataset(conn: &Connection, req: SaveDatasetRequest) -> AppResult<SyncedDataset> {
    let (name, data_json) = check_write(&req.name, &req.data_json)?;
    match req.id {
        Some(id) => {
            let changed = conn.execute(
                "UPDATE synced_datasets SET name = ?1, data_json = ?2,
                        sync_state = 'dirty', updated_at = datetime('now')
                 WHERE id = ?3 AND sync_state <> 'deleted_pending'",
                rusqlite::params![name, data_json, id],
            )?;
            if changed == 0 {
                return Err(AppError::NotFound(format!("Dataset {id} not found")));
            }
        }
        None => {
            conn.execute(
                "INSERT INTO synced_datasets (server_id, name, data_json)
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![uuid::Uuid::new_v4().to_string(), name, data_json],
            )?;
        }
    }
    let id = match req.id {
        Some(id) => id,
        None => conn.last_insert_rowid(),
    };
    conn.query_row(
        &format!("SELECT {SELECT_COLS} FROM synced_datasets WHERE id = ?1"),
        [id],
        row_to_dataset,
    )
    .map_err(|_| AppError::NotFound(format!("Dataset {id} not found")))
}

/// Deletes a dataset locally as a tombstone; the engine confirms the
/// delete with the server and forgets the row. Idempotent.
pub fn tombstone_dataset(conn: &Connection, id: i64) -> AppResult<()> {
    let changed = conn.execute(
        "UPDATE synced_datasets SET sync_state = 'deleted_pending', updated_at = datetime('now')
         WHERE id = ?1",
        [id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("Dataset {id} not found")));
    }
    Ok(())
}

// ── Cache side (the sync engine's view) ─────────────────────────

pub fn apply_dataset_upsert(
    tx: &Transaction,
    data: &DatasetDataIn,
    report: &mut crate::commands::cache::ApplyReport,
) -> AppResult<()> {
    let existing: Option<(i64, String)> = tx
        .query_row(
            "SELECT id, sync_state FROM synced_datasets WHERE server_id = ?1",
            [&data.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    match existing {
        // Only synced rows take server state; dirty rows keep local
        // edits, conflicted rows wait for the user's decision (a later
        // local save rebases them), tombstones wait for the server.
        Some((_, state)) if state != "synced" => {
            report.skipped_dirty += 1;
            Ok(())
        }
        Some((id, _)) => {
            tx.execute(
                "UPDATE synced_datasets SET name = ?1, data_json = ?2,
                        server_revision = ?3, base_revision = ?3,
                        synced_at = datetime('now'), sync_state = 'synced',
                        updated_at = datetime('now')
                 WHERE id = ?4",
                rusqlite::params![data.name, data.data_json, data.revision, id],
            )?;
            report.applied_upserts += 1;
            Ok(())
        }
        None => {
            tx.execute(
                "INSERT INTO synced_datasets
                    (server_id, name, data_json, server_revision, base_revision,
                     sync_state, synced_at)
                 VALUES (?1, ?2, ?3, ?4, ?4, 'synced', datetime('now'))",
                rusqlite::params![data.id, data.name, data.data_json, data.revision],
            )?;
            report.applied_upserts += 1;
            Ok(())
        }
    }
}

pub fn apply_dataset_delete(
    tx: &Transaction,
    server_id: &str,
    report: &mut crate::commands::cache::ApplyReport,
) -> AppResult<()> {
    let existing: Option<(i64, String)> = tx
        .query_row(
            "SELECT id, sync_state FROM synced_datasets WHERE server_id = ?1",
            [server_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    match existing {
        None => Ok(()),
        Some(_) if !dataset_is_synced(tx, server_id)? => {
            report.skipped_dirty += 1;
            Ok(())
        }
        Some((id, _)) => {
            tx.execute("DELETE FROM synced_datasets WHERE id = ?1", [id])?;
            report.applied_deletes += 1;
            Ok(())
        }
    }
}

fn dataset_is_synced(tx: &Transaction, server_id: &str) -> rusqlite::Result<bool> {
    let state: String = tx.query_row(
        "SELECT sync_state FROM synced_datasets WHERE server_id = ?1",
        [server_id],
        |r| r.get(0),
    )?;
    Ok(state == "synced")
}

pub fn list_dirty_datasets(conn: &Connection) -> AppResult<Vec<DirtyDataset>> {
    let mut stmt = conn.prepare(
        "SELECT server_id, name, data_json, base_revision
         FROM synced_datasets WHERE sync_state = 'dirty' ORDER BY id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(DirtyDataset {
                server_id: r.get(0)?,
                name: r.get(1)?,
                data_json: r.get(2)?,
                base_revision: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Records a successful push: the row is clean and both revisions track
/// the server's.
pub fn mark_dataset_pushed(conn: &Connection, server_id: &str, revision: i64) -> AppResult<()> {
    let changed = conn.execute(
        "UPDATE synced_datasets SET sync_state = 'synced', server_revision = ?1, base_revision = ?1
         WHERE server_id = ?2",
        rusqlite::params![revision, server_id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!(
            "no cached dataset with server id {server_id}"
        )));
    }
    Ok(())
}

/// Tombstoned rows waiting for the server to confirm their deletion.
pub fn list_tombstoned_datasets(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT server_id FROM synced_datasets WHERE sync_state = 'deleted_pending'")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<Vec<String>, _>>()?)
}

/// Synced rows, for the reset pass: the engine drops every synced row
/// the full pass did not contain.
pub fn list_synced_datasets(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT server_id FROM synced_datasets WHERE sync_state = 'synced'")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<Vec<String>, _>>()?)
}

/// Forgets a local copy outright. Used after the server confirms a
/// delete and when a reset pass proves a synced row is gone. Idempotent.
pub fn forget_dataset(conn: &Connection, server_id: &str) -> AppResult<bool> {
    let changed = conn.execute(
        "DELETE FROM synced_datasets WHERE server_id = ?1",
        [server_id],
    )?;
    Ok(changed > 0)
}

// ── Tauri wrappers: lock, delegate, no logic ────────────────────

#[tauri::command]
pub fn list_datasets(db: State<DbState>) -> AppResult<Vec<SyncedDataset>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    query_datasets(guard.connection())
}

#[tauri::command]
pub fn save_dataset(db: State<DbState>, req: SaveDatasetRequest) -> AppResult<SyncedDataset> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    store_dataset(guard.connection(), req)
}

#[tauri::command]
pub fn delete_dataset(db: State<DbState>, id: i64) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    tombstone_dataset(guard.connection(), id)
}

#[tauri::command]
pub fn cache_list_dirty_datasets(db: State<DbState>) -> AppResult<Vec<DirtyDataset>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    list_dirty_datasets(guard.connection())
}

#[tauri::command]
pub fn cache_mark_dataset_pushed(
    db: State<DbState>,
    server_id: String,
    revision: i64,
) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    mark_dataset_pushed(guard.connection(), &server_id, revision)
}

#[tauri::command]
pub fn cache_list_tombstoned_datasets(db: State<DbState>) -> AppResult<Vec<String>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    list_tombstoned_datasets(guard.connection())
}

#[tauri::command]
pub fn cache_list_synced_datasets(db: State<DbState>) -> AppResult<Vec<String>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    list_synced_datasets(guard.connection())
}

#[tauri::command]
pub fn cache_forget_dataset(db: State<DbState>, server_id: String) -> AppResult<bool> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    forget_dataset(guard.connection(), &server_id)
}
