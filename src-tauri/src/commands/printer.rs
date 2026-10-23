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

/// Shared by add and update so the UI, the API and the tests see one
/// rulebook with identical messages.
fn validate_printer_input(name: &str, printer_type: &str, language: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("Printer name required".into()));
    }
    if !VALID_PRINTER_TYPES.contains(&printer_type) {
        return Err(AppError::Validation(format!(
            "Invalid printer type '{}'. Expected one of {:?}",
            printer_type, VALID_PRINTER_TYPES
        )));
    }
    if !VALID_LANGUAGES.contains(&language) {
        return Err(AppError::Validation(format!(
            "Invalid language '{}'. Expected one of {:?}",
            language, VALID_LANGUAGES
        )));
    }
    Ok(name.to_string())
}

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
    let name = validate_printer_input(&req.name, &req.printer_type, &req.language)?;

    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM printers WHERE name = ?1 COLLATE NOCASE",
        [&name],
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

/// Edit a printer in place (the UI used to require delete + re-add,
/// losing profiles keyed by name). Same validation as add; the
/// duplicate-name check excludes the row being edited.
#[tauri::command]
pub fn update_printer(db: State<DbState>, id: i64, req: AddPrinterRequest) -> AppResult<Printer> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    update_printer_conn(guard.connection(), id, &req)
}

/// Test seam for the edit path: the Tauri command only adds the lock.
/// Public so integration tests can drive validation and the duplicate
/// check against a real database without a Tauri runtime.
pub fn update_printer_conn(
    conn: &rusqlite::Connection,
    id: i64,
    req: &AddPrinterRequest,
) -> AppResult<Printer> {
    let name = validate_printer_input(&req.name, &req.printer_type, &req.language)?;

    let clash: i64 = conn.query_row(
        "SELECT COUNT(*) FROM printers WHERE name = ?1 COLLATE NOCASE AND id <> ?2",
        rusqlite::params![name, id],
        |r| r.get(0),
    )?;
    if clash > 0 {
        return Err(AppError::Validation(format!(
            "A printer named '{}' already exists",
            name
        )));
    }

    let affected = conn.execute(
        "UPDATE printers SET name = ?1, type = ?2, address = ?3, language = ?4,
                paper_width_mm = ?5, dpi = ?6, updated_at = datetime('now')
         WHERE id = ?7",
        rusqlite::params![
            name,
            req.printer_type,
            req.address,
            req.language,
            req.paper_width_mm,
            req.dpi,
            id,
        ],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("Printer {} not found", id)));
    }
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

fn get_printer_inner(db: &DbState, id: i64) -> AppResult<Printer> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    guard
        .connection()
        .query_row(
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
    get_printer_inner(&db, id)
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
        data: None,
        data_url: None,
        http_method: None,
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
