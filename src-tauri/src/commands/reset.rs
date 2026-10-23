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
//! The wipe is a file delete, not row deletes: the SQLite file (plus WAL
//! and journal sidecars) is removed and recreated through the one schema
//! path, so the result is byte-identical to a fresh install — no rows, no
//! `sqlite_sequence` counters, no freelist pages, no drift from old
//! migrations. The in-memory print queue holds no row references (permits
//! and wake-ups only), so the worker just sees empty tables afterwards.
//! Dead tables from old installs (`printer_profiles`, `sample_datasets`,
//! `presets`) vanish with the file instead of needing individual drops.

use crate::db::{Database, DbState};
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

/// The work behind [`reset_database`]: report what was there, delete the
/// file and reopen fresh, drop font bytes with their rows. Split out so
/// tests run it against a real file database without a Tauri app around.
pub fn recreate_database(db: &mut Database, fonts_dir: &Path) -> AppResult<ResetReport> {
    let report = ResetReport {
        templates: count(db.connection(), "templates")?,
        template_versions: count(db.connection(), "template_versions")?,
        print_jobs: count(db.connection(), "print_jobs")?,
        fonts: count(db.connection(), "fonts")?,
        datasets: count(db.connection(), "synced_datasets")?,
        profiles: count(db.connection(), "synced_profiles")?,
        printers: count(db.connection(), "printers")?,
        batches: count(db.connection(), "batches")?,
    };
    // Font bytes live outside the database; drop them with their rows.
    let font_paths: Vec<String> = db
        .connection()
        .prepare("SELECT file_path FROM fonts WHERE file_path <> ''")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;

    db.recreate().map_err(|e| {
        AppError::Internal(format!(
            "database file deleted but reopen failed ({e}); restart the app to recreate it"
        ))
    })?;
    for stored in font_paths {
        let _ = std::fs::remove_file(crate::commands::font::resolve_font_path(fonts_dir, &stored));
    }
    let _ = std::fs::remove_dir(fonts_dir);
    Ok(report)
}

// ── Tauri wrapper: lock, delegate, no logic ────────────────────

#[tauri::command]
pub fn reset_database(app: AppHandle, db: State<DbState>) -> AppResult<ResetReport> {
    let fonts_dir = app.path().app_data_dir()?.join("fonts");
    let mut guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    recreate_database(&mut guard, &fonts_dir)
}
