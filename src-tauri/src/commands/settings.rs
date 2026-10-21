use crate::db::DbState;
use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use tauri::State;

/// Deep-link sources allowed to skip the confirmation sheet.
#[tauri::command]
pub fn get_trusted_sources(db: State<DbState>) -> AppResult<Vec<String>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'trusted_sources'",
            [],
            |r| r.get(0),
        )
        .ok();

    // Stored as a JSON array; fall back to a comma-separated list for
    // values written by older builds.
    match raw {
        Some(v) => match serde_json::from_str::<Vec<String>>(&v) {
            Ok(list) => Ok(list),
            Err(_) => Ok(v
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()),
        },
        None => Ok(vec![]),
    }
}

#[tauri::command]
pub fn set_trusted_sources(db: State<DbState>, sources: Vec<String>) -> AppResult<()> {
    let json = serde_json::to_string(&sources)
        .map_err(|e| AppError::Internal(format!("serialize failed: {}", e)))?;

    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('trusted_sources', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [json],
    )?;

    Ok(())
}

#[tauri::command]
pub fn get_setting(db: State<DbState>, key: String) -> AppResult<Option<String>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query([&key])?;

    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn set_setting(db: State<DbState>, key: String, value: String) -> AppResult<()> {
    if key.trim().is_empty() {
        return Err(AppError::Validation("Setting key required".into()));
    }

    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    write_setting(guard.connection(), &key, &value)
}

// ── Account preferences (Phase 4) ───────────────────────────────
// The allow-list is the only thing that ever leaves the device; the
// server 400s anything else, and device keys keep the 'synced' default
// forever so the engine never pushes them.

/// Settings keys that live on the account and sync (REFACTORING.md
/// question 23, answered). Everything else is device-local.
pub const ACCOUNT_SETTING_KEYS: &[&str] = &["ui_density", "brand_name", "brand_logo"];

pub fn is_account_setting(key: &str) -> bool {
    ACCOUNT_SETTING_KEYS.contains(&key)
}

/// Writes one setting, marking account keys dirty (or tombstoned
/// when the value is empty). Plain so tests can drive it directly.
pub fn write_setting(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )?;
    if is_account_setting(key) {
        // An empty value resets the preference: the engine deletes it on
        // the server. Anything else uploads on the next push.
        let state = if value.is_empty() {
            "deleted_pending"
        } else {
            "dirty"
        };
        conn.execute(
            "UPDATE settings SET sync_state = ?1, synced_at = NULL WHERE key = ?2",
            rusqlite::params![state, key],
        )?;
    }
    Ok(())
}

/// One record from a sync upsert. Field names match the wire shape.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct SettingDataIn {
    pub key: String,
    pub value: String,
    pub revision: i64,
}

/// A preference waiting to be pushed. Settings have no revisions to
/// send (last writer wins); the tombstone flag decides between PUT and
/// DELETE.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DirtySetting {
    pub key: String,
    pub value: String,
    pub tombstone: bool,
}

pub fn list_dirty_settings(conn: &Connection) -> AppResult<Vec<DirtySetting>> {
    let mut stmt = conn.prepare(
        "SELECT key, value, sync_state FROM settings
         WHERE sync_state <> 'synced' ORDER BY key",
    )?;
    let rows = stmt
        .query_map([], |r| {
            let state: String = r.get(2)?;
            Ok(DirtySetting {
                key: r.get(0)?,
                value: r.get(1)?,
                tombstone: state == "deleted_pending",
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    // Device keys can never be dirty (only account writes mark them),
    // but belt and braces: the engine must never push them.
    Ok(rows
        .into_iter()
        .filter(|r| is_account_setting(&r.key))
        .collect())
}

/// Records a successful push: the row is clean again.
pub fn mark_setting_pushed(conn: &Connection, key: &str) -> AppResult<()> {
    let changed = conn.execute(
        "UPDATE settings SET sync_state = 'synced', synced_at = datetime('now')
         WHERE key = ?1",
        [key],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("Setting '{key}' not found")));
    }
    Ok(())
}

/// Tombstoned preferences waiting for the server to confirm the reset.
pub fn list_tombstoned_settings(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT key FROM settings WHERE sync_state = 'deleted_pending'")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<Vec<String>, _>>()?)
}

/// Synced account preferences, for the reset pass: the engine drops
/// every synced row the full pass did not contain.
pub fn list_synced_settings(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT key FROM settings WHERE sync_state = 'synced'")?;
    let rows = stmt.query_map([], |r| {
        let key: String = r.get(0)?;
        Ok(key)
    })?;
    Ok(rows
        .collect::<Result<Vec<String>, _>>()?
        .into_iter()
        .filter(|k| is_account_setting(k))
        .collect())
}

/// Forgets a preference outright: the local value falls back to the
/// default until the next pull. Idempotent.
pub fn forget_setting(conn: &Connection, key: &str) -> AppResult<bool> {
    let changed = conn.execute("DELETE FROM settings WHERE key = ?1", [key])?;
    Ok(changed > 0)
}

pub fn apply_setting_upsert(
    tx: &rusqlite::Transaction,
    data: &SettingDataIn,
    report: &mut crate::commands::cache::ApplyReport,
) -> AppResult<()> {
    let state: Option<String> = tx
        .query_row(
            "SELECT sync_state FROM settings WHERE key = ?1",
            [&data.key],
            |r| r.get(0),
        )
        .ok();
    match state.as_deref() {
        // Only synced rows take server state; dirty rows keep the local
        // edit until it pushes, tombstones wait for the server.
        Some(s) if s != "synced" => {
            report.skipped_dirty += 1;
            Ok(())
        }
        _ => {
            tx.execute(
                "INSERT INTO settings (key, value, sync_state, synced_at)
                 VALUES (?1, ?2, 'synced', datetime('now'))
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                       sync_state = 'synced', synced_at = datetime('now')",
                rusqlite::params![data.key, data.value],
            )?;
            report.applied_upserts += 1;
            Ok(())
        }
    }
}

pub fn apply_setting_delete(
    tx: &rusqlite::Transaction,
    key: &str,
    report: &mut crate::commands::cache::ApplyReport,
) -> AppResult<()> {
    let state: Option<String> = tx
        .query_row(
            "SELECT sync_state FROM settings WHERE key = ?1",
            [key],
            |r| r.get(0),
        )
        .ok();
    match state.as_deref() {
        None => Ok(()),
        Some(s) if s != "synced" => {
            report.skipped_dirty += 1;
            Ok(())
        }
        _ => {
            tx.execute("DELETE FROM settings WHERE key = ?1", [key])?;
            report.applied_deletes += 1;
            Ok(())
        }
    }
}

// ── Tauri wrappers: lock, delegate, no logic ────────────────────

#[tauri::command]
pub fn cache_list_dirty_settings(db: State<DbState>) -> AppResult<Vec<DirtySetting>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    list_dirty_settings(guard.connection())
}

#[tauri::command]
pub fn cache_mark_setting_pushed(db: State<DbState>, key: String) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    mark_setting_pushed(guard.connection(), &key)
}

#[tauri::command]
pub fn cache_list_tombstoned_settings(db: State<DbState>) -> AppResult<Vec<String>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    list_tombstoned_settings(guard.connection())
}

#[tauri::command]
pub fn cache_list_synced_settings(db: State<DbState>) -> AppResult<Vec<String>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    list_synced_settings(guard.connection())
}

#[tauri::command]
pub fn cache_forget_setting(db: State<DbState>, key: String) -> AppResult<bool> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    forget_setting(guard.connection(), &key)
}
