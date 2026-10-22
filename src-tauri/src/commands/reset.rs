//! Full local database reset (Settings → Retention → Reset).
//!
//! Unlike `cache_clear_account` (account cache only, device tables kept),
//! this wipes everything the app owns on this PC: templates and versions,
//! print history and batches, printers, fonts (rows and files), the synced
//! library rows, the sync state, queued uses, API clients and every
//! setting — including the session token and server URL, so the app
//! returns to the welcome screen. The server is untouched: it still holds
//! the account, and signing back in pulls it down again.
//!
//! Everything cleared here is user data, never schema: tables, indexes
//! and migrations stay, so the app keeps working with an empty database.
//! Dead tables from old installs (`printer_profiles`, `sample_datasets`,
//! `presets`) are dropped if they somehow still exist. Child rows go
//! first so the wipe never depends on foreign-key enforcement.

use crate::db::DbState;
use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResetReport {
    pub templates: usize,
    pub template_versions: usize,
    pub print_jobs: usize,
    pub fonts: usize,
    pub datasets: usize,
    pub profiles: usize,
    pub printers: usize,
    pub batches: usize,
}

fn count(conn: &Connection, table: &str) -> AppResult<usize> {
    let n: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
    Ok(n as usize)
}

pub fn wipe_database(conn: &Connection, fonts_dir: &Path) -> AppResult<ResetReport> {
    let report = ResetReport {
        templates: count(conn, "templates")?,
        template_versions: count(conn, "template_versions")?,
        print_jobs: count(conn, "print_jobs")?,
        fonts: count(conn, "fonts")?,
        datasets: count(conn, "synced_datasets")?,
        profiles: count(conn, "synced_profiles")?,
        printers: count(conn, "printers")?,
        batches: count(conn, "batches")?,
    };
    // Font bytes live outside the database; drop them with their rows.
    let font_paths: Vec<String> = conn
        .prepare("SELECT file_path FROM fonts WHERE file_path <> ''")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;

    conn.execute_batch(
        "DELETE FROM print_jobs;
         DELETE FROM template_versions;
         DELETE FROM templates;
         DELETE FROM fonts;
         DELETE FROM synced_datasets;
         DELETE FROM synced_profiles;
         DELETE FROM batches;
         DELETE FROM printers;
         DELETE FROM api_clients;
         DELETE FROM queued_uses;
         DELETE FROM sync_state;
         DELETE FROM settings;
         DROP TABLE IF EXISTS printer_profiles;
         DROP TABLE IF EXISTS sample_datasets;
         DROP TABLE IF EXISTS presets;",
    )?;
    for stored in font_paths {
        let _ = std::fs::remove_file(crate::commands::font::resolve_font_path(
            fonts_dir,
            &stored,
        ));
    }
    let _ = std::fs::remove_dir(fonts_dir);
    Ok(report)
}

// ── Tauri wrapper: lock, delegate, no logic ────────────────────

#[tauri::command]
pub fn reset_database(app: AppHandle, db: State<DbState>) -> AppResult<ResetReport> {
    let fonts_dir = app.path().app_data_dir()?.join("fonts");
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    wipe_database(guard.connection(), &fonts_dir)
}
