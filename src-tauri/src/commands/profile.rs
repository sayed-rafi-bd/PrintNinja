//! Printer profiles, synced by template and printer name (Phase 4).
//!
//! The server keys one profile per (template, lowercase printer name),
//! so the local cache mirrors that key instead of the old local
//! (printer_id, template_id) pair. `save_profile` still takes local ids
//! (that is what the print flow knows) and resolves them to the server
//! key; `list_profiles` filters by local ids the same way. A row whose
//! printer is unknown on this PC — or renamed, or deleted — matches no
//! filter and stays dormant until the printer appears.

use crate::db::DbState;
use crate::error::{AppError, AppResult};
use rusqlite::{Connection, Transaction};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize)]
pub struct PrinterProfile {
    pub id: i64,
    /// Local linkage, resolved from the server key. Null when this PC
    /// has no such printer or template: the row is dormant, not broken.
    pub printer_id: Option<i64>,
    pub template_id: Option<i64>,
    pub server_id: String,
    pub template_server_id: String,
    pub printer_name: String,
    pub settings_json: String,
    pub created_at: String,
    pub updated_at: String,
}

/// One record from a sync upsert. Field names match the wire shape.
#[derive(Debug, Clone, Deserialize)]
pub struct ProfileDataIn {
    pub id: String,
    pub template_id: String,
    pub printer_name: String,
    pub settings_json: String,
    pub revision: i64,
}

/// A row waiting to be pushed: everything the PUT needs plus the base
/// revision the next push must send as `if_revision` (null for rows that
/// never reached the server).
#[derive(Debug, Clone, Serialize)]
pub struct DirtyProfile {
    pub server_id: String,
    pub template_id: String,
    pub printer_name: String,
    pub settings_json: String,
    pub base_revision: Option<i64>,
}

/// The printer's current name, lowercased: the server key (question 20).
fn printer_key(conn: &Connection, printer_id: i64) -> AppResult<String> {
    let name: Option<String> = conn
        .query_row(
            "SELECT name FROM printers WHERE id = ?1",
            [printer_id],
            |r| r.get(0),
        )
        .ok();
    match name {
        Some(n) => Ok(n.to_lowercase()),
        None => Err(AppError::NotFound(format!(
            "Printer {printer_id} not found"
        ))),
    }
}

/// The template's sync identity: the server-side template id.
fn template_key(conn: &Connection, template_id: i64) -> AppResult<String> {
    let server_id: Option<Option<String>> = conn
        .query_row(
            "SELECT server_id FROM templates WHERE id = ?1",
            [template_id],
            |r| r.get(0),
        )
        .ok();
    match server_id {
        Some(Some(id)) => Ok(id),
        _ => Err(AppError::Validation(format!(
            "Template {template_id} is not synced yet"
        ))),
    }
}

fn row_to_profile(conn: &Connection, row: &rusqlite::Row) -> rusqlite::Result<PrinterProfile> {
    let template_server_id: String = row.get(2)?;
    let printer_name: String = row.get(3)?;
    // Best-effort linkage: missing printer or template means dormant.
    let template_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM templates WHERE server_id = ?1",
            [&template_server_id],
            |r| r.get(0),
        )
        .ok();
    let printer_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM printers WHERE LOWER(name) = ?1",
            [&printer_name],
            |r| r.get(0),
        )
        .ok();
    Ok(PrinterProfile {
        id: row.get(0)?,
        printer_id,
        template_id,
        server_id: row.get(1)?,
        template_server_id,
        printer_name,
        settings_json: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

const SELECT_COLS: &str =
    "id, server_id, template_server_id, printer_name, settings_json, created_at, updated_at";

pub fn query_profiles(
    conn: &Connection,
    printer_id: Option<i64>,
    template_id: Option<i64>,
) -> AppResult<Vec<PrinterProfile>> {
    let mut sql = format!("SELECT {SELECT_COLS} FROM synced_profiles WHERE 1=1");
    if printer_id.is_some() {
        sql.push_str(" AND printer_name = (SELECT LOWER(name) FROM printers WHERE id = ?)");
    }
    if template_id.is_some() {
        sql.push_str(" AND template_server_id = (SELECT server_id FROM templates WHERE id = ?)");
    }
    sql.push_str(" ORDER BY updated_at DESC");
    let mut stmt = conn.prepare(&sql)?;
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(p) = printer_id {
        params.push(Box::new(p));
    }
    if let Some(t) = template_id {
        params.push(Box::new(t));
    }
    let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
    let rows = stmt
        .query_map(refs.as_slice(), |row| row_to_profile(conn, row))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[derive(Debug, Deserialize)]
pub struct SaveProfileRequest {
    pub printer_id: i64,
    pub template_id: i64,
    pub settings_json: String,
}

/// Saves a profile as a dirty cache write. The row is keyed by template
/// and printer name, so re-saving updates it; the engine pushes it.
pub fn store_profile(conn: &Connection, req: SaveProfileRequest) -> AppResult<PrinterProfile> {
    serde_json::from_str::<serde_json::Value>(&req.settings_json)
        .map_err(|e| AppError::Validation(format!("Invalid settings JSON: {e}")))?;

    let printer_name = printer_key(conn, req.printer_id)?;
    let template_server_id = template_key(conn, req.template_id)?;

    conn.execute(
        "INSERT INTO synced_profiles (server_id, template_server_id, printer_name, settings_json)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(template_server_id, printer_name)
         DO UPDATE SET settings_json = excluded.settings_json,
                       sync_state = 'dirty', updated_at = datetime('now')",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            template_server_id,
            printer_name,
            req.settings_json
        ],
    )?;

    conn.query_row(
        &format!("SELECT {SELECT_COLS} FROM synced_profiles WHERE template_server_id = ?1 AND printer_name = ?2"),
        rusqlite::params![template_server_id, printer_name],
        |row| row_to_profile(conn, row),
    )
    .map_err(|e| AppError::Database(e.to_string()))
}

/// Deletes a profile locally as a tombstone; the engine confirms the
/// delete with the server and forgets the row. Idempotent.
pub fn tombstone_profile(conn: &Connection, id: i64) -> AppResult<()> {
    let changed = conn.execute(
        "UPDATE synced_profiles SET sync_state = 'deleted_pending', updated_at = datetime('now')
         WHERE id = ?1",
        [id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("Profile {id} not found")));
    }
    Ok(())
}

// ── Cache side (the sync engine's view) ─────────────────────────

pub fn apply_profile_upsert(
    tx: &Transaction,
    data: &ProfileDataIn,
    report: &mut crate::commands::cache::ApplyReport,
) -> AppResult<()> {
    let existing: Option<(i64, String)> = tx
        .query_row(
            "SELECT id, sync_state FROM synced_profiles WHERE server_id = ?1",
            [&data.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    match existing {
        // Only synced rows take server state; dirty rows keep local
        // edits, conflicted rows wait (a later save rebases them),
        // tombstones wait for the server.
        Some((_, state)) if state != "synced" => {
            report.skipped_dirty += 1;
            Ok(())
        }
        Some((id, _)) => {
            tx.execute(
                "UPDATE synced_profiles SET template_server_id = ?1, printer_name = ?2,
                        settings_json = ?3, server_revision = ?4, base_revision = ?4,
                        synced_at = datetime('now'), sync_state = 'synced',
                        updated_at = datetime('now')
                 WHERE id = ?5",
                rusqlite::params![
                    data.template_id,
                    data.printer_name,
                    data.settings_json,
                    data.revision,
                    id
                ],
            )?;
            report.applied_upserts += 1;
            Ok(())
        }
        None => {
            tx.execute(
                "INSERT INTO synced_profiles
                    (server_id, template_server_id, printer_name, settings_json,
                     server_revision, base_revision, sync_state, synced_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5, 'synced', datetime('now'))",
                rusqlite::params![
                    data.id,
                    data.template_id,
                    data.printer_name,
                    data.settings_json,
                    data.revision
                ],
            )?;
            report.applied_upserts += 1;
            Ok(())
        }
    }
}

pub fn apply_profile_delete(
    tx: &Transaction,
    server_id: &str,
    report: &mut crate::commands::cache::ApplyReport,
) -> AppResult<()> {
    let existing: Option<(i64, String)> = tx
        .query_row(
            "SELECT id, sync_state FROM synced_profiles WHERE server_id = ?1",
            [server_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    match existing {
        None => Ok(()),
        Some(_) if !profile_is_synced(tx, server_id)? => {
            report.skipped_dirty += 1;
            Ok(())
        }
        Some((id, _)) => {
            tx.execute("DELETE FROM synced_profiles WHERE id = ?1", [id])?;
            report.applied_deletes += 1;
            Ok(())
        }
    }
}

fn profile_is_synced(tx: &Transaction, server_id: &str) -> rusqlite::Result<bool> {
    let state: String = tx.query_row(
        "SELECT sync_state FROM synced_profiles WHERE server_id = ?1",
        [server_id],
        |r| r.get(0),
    )?;
    Ok(state == "synced")
}

pub fn list_dirty_profiles(conn: &Connection) -> AppResult<Vec<DirtyProfile>> {
    let mut stmt = conn.prepare(
        "SELECT server_id, template_server_id, printer_name, settings_json, base_revision
         FROM synced_profiles WHERE sync_state = 'dirty' ORDER BY id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(DirtyProfile {
                server_id: r.get(0)?,
                template_id: r.get(1)?,
                printer_name: r.get(2)?,
                settings_json: r.get(3)?,
                base_revision: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Records a successful push: the row is clean and both revisions track
/// the server's.
pub fn mark_profile_pushed(conn: &Connection, server_id: &str, revision: i64) -> AppResult<()> {
    let changed = conn.execute(
        "UPDATE synced_profiles SET sync_state = 'synced', server_revision = ?1, base_revision = ?1
         WHERE server_id = ?2",
        rusqlite::params![revision, server_id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!(
            "no cached profile with server id {server_id}"
        )));
    }
    Ok(())
}

/// Tombstoned rows waiting for the server to confirm their deletion.
pub fn list_tombstoned_profiles(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT server_id FROM synced_profiles WHERE sync_state = 'deleted_pending'")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<Vec<String>, _>>()?)
}

/// Synced rows, for the reset pass: the engine drops every synced row
/// the full pass did not contain.
pub fn list_synced_profiles(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT server_id FROM synced_profiles WHERE sync_state = 'synced'")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<Vec<String>, _>>()?)
}

/// Forgets a local copy outright. Used after the server confirms a
/// delete and when a reset pass proves a synced row is gone. Idempotent.
pub fn forget_profile(conn: &Connection, server_id: &str) -> AppResult<bool> {
    let changed = conn.execute(
        "DELETE FROM synced_profiles WHERE server_id = ?1",
        [server_id],
    )?;
    Ok(changed > 0)
}

// ── Tauri wrappers: lock, delegate, no logic ────────────────────

#[tauri::command]
pub fn list_profiles(
    db: State<DbState>,
    printer_id: Option<i64>,
    template_id: Option<i64>,
) -> AppResult<Vec<PrinterProfile>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    query_profiles(guard.connection(), printer_id, template_id)
}

#[tauri::command]
pub fn save_profile(db: State<DbState>, req: SaveProfileRequest) -> AppResult<PrinterProfile> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    store_profile(guard.connection(), req)
}

#[tauri::command]
pub fn delete_profile(db: State<DbState>, id: i64) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    tombstone_profile(guard.connection(), id)
}

#[tauri::command]
pub fn cache_list_dirty_profiles(db: State<DbState>) -> AppResult<Vec<DirtyProfile>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    list_dirty_profiles(guard.connection())
}

#[tauri::command]
pub fn cache_mark_profile_pushed(
    db: State<DbState>,
    server_id: String,
    revision: i64,
) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    mark_profile_pushed(guard.connection(), &server_id, revision)
}

#[tauri::command]
pub fn cache_list_tombstoned_profiles(db: State<DbState>) -> AppResult<Vec<String>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    list_tombstoned_profiles(guard.connection())
}

#[tauri::command]
pub fn cache_list_synced_profiles(db: State<DbState>) -> AppResult<Vec<String>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    list_synced_profiles(guard.connection())
}

#[tauri::command]
pub fn cache_forget_profile(db: State<DbState>, server_id: String) -> AppResult<bool> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    forget_profile(guard.connection(), &server_id)
}
