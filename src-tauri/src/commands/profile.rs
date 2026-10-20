use crate::db::DbState;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrinterProfile {
    pub id: i64,
    pub printer_id: i64,
    pub template_id: i64,
    pub settings_json: String,
    pub created_at: String,
    pub updated_at: String,
}

#[tauri::command]
pub fn list_profiles(
    db: State<DbState>,
    printer_id: Option<i64>,
    template_id: Option<i64>,
) -> AppResult<Vec<PrinterProfile>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    let mut sql = String::from(
        "SELECT id, printer_id, template_id, settings_json, created_at, updated_at
         FROM printer_profiles WHERE 1=1",
    );
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(p) = printer_id {
        sql.push_str(" AND printer_id = ?");
        params.push(Box::new(p));
    }
    if let Some(t) = template_id {
        sql.push_str(" AND template_id = ?");
        params.push(Box::new(t));
    }
    sql.push_str(" ORDER BY updated_at DESC");

    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();

    let profiles = stmt
        .query_map(refs.as_slice(), |row| {
            Ok(PrinterProfile {
                id: row.get(0)?,
                printer_id: row.get(1)?,
                template_id: row.get(2)?,
                settings_json: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(profiles)
}

#[derive(Debug, Deserialize)]
pub struct SaveProfileRequest {
    pub printer_id: i64,
    pub template_id: i64,
    pub settings_json: String,
}

#[tauri::command]
pub fn save_profile(db: State<DbState>, req: SaveProfileRequest) -> AppResult<PrinterProfile> {
    // Validate the payload parses as JSON before storing it, otherwise the
    // UI will later crash trying to read it back.
    serde_json::from_str::<serde_json::Value>(&req.settings_json)
        .map_err(|e| AppError::Validation(format!("Invalid settings JSON: {}", e)))?;

    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    // Ensure the referenced rows exist so profiles never dangle.
    for (id, table) in [(req.printer_id, "printers"), (req.template_id, "templates")] {
        let n: i64 = conn.query_row(
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

    // One profile per printer+template pair; re-saving updates it.
    conn.execute(
        "INSERT INTO printer_profiles (printer_id, template_id, settings_json)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(printer_id, template_id)
         DO UPDATE SET settings_json = excluded.settings_json,
                       updated_at = datetime('now')",
        rusqlite::params![req.printer_id, req.template_id, req.settings_json],
    )?;

    let profile = conn.query_row(
        "SELECT id, printer_id, template_id, settings_json, created_at, updated_at
         FROM printer_profiles WHERE printer_id = ?1 AND template_id = ?2",
        rusqlite::params![req.printer_id, req.template_id],
        |row| {
            Ok(PrinterProfile {
                id: row.get(0)?,
                printer_id: row.get(1)?,
                template_id: row.get(2)?,
                settings_json: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    )?;

    Ok(profile)
}

#[tauri::command]
pub fn delete_profile(db: State<DbState>, id: i64) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    let affected = conn.execute("DELETE FROM printer_profiles WHERE id = ?1", [id])?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("Profile {} not found", id)));
    }
    Ok(())
}
