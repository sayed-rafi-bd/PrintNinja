use crate::db::DbState;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FontInfo {
    pub id: i64,
    pub family: String,
    pub style: String,
    pub weight: String,
    pub file_path: String,
    pub format: String,
    pub created_at: String,
}

const VALID_FORMATS: &[&str] = &["ttf", "otf", "woff", "woff2"];

#[tauri::command]
pub fn list_fonts(db: State<DbState>) -> AppResult<Vec<FontInfo>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    let mut stmt = conn.prepare(
        "SELECT id, family, style, weight, file_path, format, created_at
         FROM fonts ORDER BY family COLLATE NOCASE",
    )?;

    let fonts = stmt
        .query_map([], |row| {
            Ok(FontInfo {
                id: row.get(0)?,
                family: row.get(1)?,
                style: row.get(2)?,
                weight: row.get(3)?,
                format: row.get::<_, String>(5)?,
                file_path: row.get(4)?,
                created_at: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(fonts)
}

#[tauri::command]
pub async fn upload_font(
    app: AppHandle,
    db: State<'_, DbState>,
    file_name: String,
    file_data: Vec<u8>,
    family: Option<String>,
) -> AppResult<FontInfo> {
    // Sanitize: only take the basename so a caller cannot traverse paths.
    let base = file_name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(&file_name)
        .to_string();

    if base.is_empty() {
        return Err(AppError::Validation("Font file name required".into()));
    }

    let ext = base.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if !VALID_FORMATS.contains(&ext.as_str()) {
        return Err(AppError::Validation(format!(
            "Unsupported font format '{}'. Expected one of {:?}",
            ext, VALID_FORMATS
        )));
    }

    if file_data.len() < 4 {
        return Err(AppError::Validation("Font file is empty".into()));
    }

    let fonts_dir = app.path().app_data_dir()?.join("fonts");
    std::fs::create_dir_all(&fonts_dir)?;

    // Unique on-disk name so re-uploading a different font with the same
    // filename does not silently clobber an existing one.
    let stored = format!("{}.{}", Uuid::new_v4(), ext);
    let dest = fonts_dir.join(&stored);
    tokio::fs::write(&dest, &file_data)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to write font: {}", e)))?;

    let family = family
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .unwrap_or_else(|| base.trim_end_matches(&format!(".{}", ext)).to_string());

    let path_str = dest.to_string_lossy().to_string();
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    conn.execute(
        "INSERT INTO fonts (family, style, weight, file_path, format)
         VALUES (?1, 'normal', '400', ?2, ?3)",
        rusqlite::params![family, path_str, ext],
    )?;

    let id = conn.last_insert_rowid();
    let created_at: String =
        conn.query_row("SELECT created_at FROM fonts WHERE id = ?1", [id], |r| {
            r.get(0)
        })?;

    Ok(FontInfo {
        id,
        family,
        style: "normal".into(),
        weight: "400".into(),
        file_path: path_str,
        format: ext,
        created_at,
    })
}

#[tauri::command]
pub fn delete_font(db: State<DbState>, id: i64) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    let path: Option<String> = conn
        .query_row("SELECT file_path FROM fonts WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .ok();

    let affected = conn.execute("DELETE FROM fonts WHERE id = ?1", [id])?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("Font {} not found", id)));
    }

    // Remove the file from disk; ignore a missing file.
    if let Some(p) = path {
        let _ = std::fs::remove_file(p);
    }

    Ok(())
}
