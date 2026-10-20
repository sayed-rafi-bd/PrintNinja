use crate::db::DbState;
use crate::error::{AppError, AppResult};
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
    let conn = guard.connection();

    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )?;

    Ok(())
}
