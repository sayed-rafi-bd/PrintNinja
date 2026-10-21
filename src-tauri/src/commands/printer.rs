use crate::db::DbState;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Printer {
    pub id: i64,
    pub name: String,
    pub printer_type: String,
    pub address: String,
    pub language: String,
    pub paper_width_mm: Option<i64>,
    pub dpi: Option<i64>,
    pub default_settings_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

const VALID_PRINTER_TYPES: &[&str] = &["ipp", "raw_tcp", "usb", "bluetooth", "system"];
const VALID_LANGUAGES: &[&str] = &["pdf", "escpos", "tspl", "zpl", "cpcl", "raster"];

#[tauri::command]
pub fn list_printers(db: State<DbState>) -> AppResult<Vec<Printer>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    let mut stmt = conn.prepare(
        "SELECT id, name, type, address, language, paper_width_mm, dpi,
                default_settings_json, created_at, updated_at
         FROM printers ORDER BY name COLLATE NOCASE",
    )?;

    let printers = stmt
        .query_map([], |row| {
            Ok(Printer {
                id: row.get(0)?,
                name: row.get(1)?,
                printer_type: row.get(2)?,
                address: row.get(3)?,
                language: row.get(4)?,
                paper_width_mm: row.get(5)?,
                dpi: row.get(6)?,
                default_settings_json: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(printers)
}

#[derive(Debug, Deserialize)]
pub struct AddPrinterRequest {
    pub name: String,
    pub printer_type: String,
    pub address: String,
    pub language: String,
    pub paper_width_mm: Option<i64>,
    pub dpi: Option<i64>,
}

#[tauri::command]
pub fn add_printer(db: State<DbState>, req: AddPrinterRequest) -> AppResult<Printer> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("Printer name required".into()));
    }
    if !VALID_PRINTER_TYPES.contains(&req.printer_type.as_str()) {
        return Err(AppError::Validation(format!(
            "Invalid printer type '{}'. Expected one of {:?}",
            req.printer_type, VALID_PRINTER_TYPES
        )));
    }
    if !VALID_LANGUAGES.contains(&req.language.as_str()) {
        return Err(AppError::Validation(format!(
            "Invalid language '{}'. Expected one of {:?}",
            req.language, VALID_LANGUAGES
        )));
    }

    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM printers WHERE name = ?1 COLLATE NOCASE",
        [name],
        |r| r.get(0),
    )?;
    if exists > 0 {
        return Err(AppError::Validation(format!(
            "A printer named '{}' already exists",
            name
        )));
    }

    conn.execute(
        "INSERT INTO printers (name, type, address, language, paper_width_mm, dpi)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            name,
            req.printer_type,
            req.address,
            req.language,
            req.paper_width_mm,
            req.dpi,
        ],
    )?;

    let id = conn.last_insert_rowid();
    let printer = conn.query_row(
        "SELECT id, name, type, address, language, paper_width_mm, dpi,
                default_settings_json, created_at, updated_at
         FROM printers WHERE id = ?1",
        [id],
        |row| {
            Ok(Printer {
                id: row.get(0)?,
                name: row.get(1)?,
                printer_type: row.get(2)?,
                address: row.get(3)?,
                language: row.get(4)?,
                paper_width_mm: row.get(5)?,
                dpi: row.get(6)?,
                default_settings_json: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        },
    )?;

    Ok(printer)
}

#[tauri::command]
pub fn delete_printer(db: State<DbState>, id: i64) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    let affected = conn.execute("DELETE FROM printers WHERE id = ?1", [id])?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("Printer {} not found", id)));
    }
    Ok(())
}

#[tauri::command]
pub fn get_printer(db: State<DbState>, id: i64) -> AppResult<Printer> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    conn.query_row(
        "SELECT id, name, type, address, language, paper_width_mm, dpi,
                default_settings_json, created_at, updated_at
         FROM printers WHERE id = ?1",
        [id],
        |row| {
            Ok(Printer {
                id: row.get(0)?,
                name: row.get(1)?,
                printer_type: row.get(2)?,
                address: row.get(3)?,
                language: row.get(4)?,
                paper_width_mm: row.get(5)?,
                dpi: row.get(6)?,
                default_settings_json: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        },
    )
    .map_err(|_| AppError::NotFound(format!("Printer {} not found", id)))
}

/// Send a small test page to a configured printer.
#[tauri::command]
pub async fn test_printer(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    queue: State<'_, crate::queue::PrintQueue>,
    id: i64,
) -> AppResult<()> {
    // Load the printer so we know where to send and which language to speak.
    let printer = {
        let guard = db
            .lock()
            .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
        let conn = guard.connection();
        conn.query_row(
            "SELECT id, name, type, address, language, paper_width_mm, dpi,
                    default_settings_json, created_at, updated_at
             FROM printers WHERE id = ?1",
            [id],
            |row| {
                Ok(Printer {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    printer_type: row.get(2)?,
                    address: row.get(3)?,
                    language: row.get(4)?,
                    paper_width_mm: row.get(5)?,
                    dpi: row.get(6)?,
                    default_settings_json: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            },
        )
        .map_err(|_| AppError::NotFound(format!("Printer {} not found", id)))?
    };

    let html = TEST_PAGE_HTML.replace("{{name}}", &printer.name);

    let req = crate::commands::print::PrintRequest {
        printer_name: printer.name.clone(),
        html,
        page_width_mm: printer.paper_width_mm.map(|v| v as f64),
        page_height_mm: None,
        orientation: Some("portrait".into()),
        copies: Some(1),
        margin_top: None,
        margin_right: None,
        margin_bottom: None,
        margin_left: None,
        fit_mode: None,
        page_range: None,
        grayscale: None,
        template_id: None,
        template_version_id: None,
        data: None,
        data_url: None,
        test: Some(true),
        source: Some("test".into()),
        idempotency_key: None,
    };

    let res = crate::commands::print::print_html(app, db, queue, req).await?;
    if res.success {
        Ok(())
    } else {
        Err(AppError::Internal(
            res.error.unwrap_or_else(|| "test print failed".into()),
        ))
    }
}

const TEST_PAGE_HTML: &str = r#"<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;padding:24px;text-align:center">
  <h1 style="font-size:24px;margin:0 0 8px">PrintNinja</h1>
  <p style="margin:0;color:#555">{{name}}</p>
  <hr style="margin:24px 0">
  <p style="font-size:12px;color:#888">Test page — if you can read this, printing works.</p>
</body></html>"#;
