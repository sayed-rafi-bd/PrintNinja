//! Fonts, synced as metadata plus bytes (Phase 4).
//!
//! A font row carries the sync identity and the server's metadata
//! (`sha256`, `size_bytes`); the file itself lives in the app-data fonts
//! folder. Uploads mark the row dirty and the engine pushes metadata
//! then bytes. Downloads arrive the other way: the pull applies the
//! metadata and marks the row pending, then `cache_download_pending_fonts`
//! fetches each missing file, checks its SHA-256 and marks it ready.
//! The per-font download state lives in Settings as
//! `font-state-<server_id>` (`pending` | `ready` | `error`) so the
//! Settings screen can show it; it never syncs (device-local, like the
//! file path).

use crate::db::DbState;
use crate::error::{AppError, AppResult};
use rusqlite::{Connection, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
pub struct FontInfo {
    pub id: i64,
    pub family: String,
    pub style: String,
    pub weight: String,
    pub file_path: String,
    pub format: String,
    pub created_at: String,
    /// The sync identity; every row has one (backfilled for old rows).
    pub server_id: String,
    pub sync_state: String,
    /// Hex SHA-256 of the stored bytes; empty until bytes land.
    pub sha256: String,
    pub size_bytes: i64,
    /// Download state from `font-state-<server_id>`: pending | ready | error.
    pub state: String,
}

/// One record from a sync upsert. Field names match the wire shape.
#[derive(Debug, Clone, Deserialize)]
pub struct FontDataIn {
    pub id: String,
    pub name: String,
    pub format: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub revision: i64,
}

/// A row whose metadata or bytes are waiting to be pushed.
#[derive(Debug, Clone, Serialize)]
pub struct DirtyFont {
    pub server_id: String,
    pub name: String,
    pub base_revision: Option<i64>,
}

const VALID_FORMATS: &[&str] = &["ttf", "otf", "woff", "woff2"];

/// Validates the upload payload before anything touches the disk:
/// known extension, non-empty, and magic bytes matching the format.
pub fn check_upload_bytes(file_name: &str, file_data: &[u8]) -> AppResult<(String, String)> {
    // Sanitize: only take the basename so a caller cannot traverse paths.
    let base = file_name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(file_name)
        .to_string();

    if base.is_empty() {
        return Err(AppError::Validation("Font file name required".into()));
    }

    let ext = base.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if !VALID_FORMATS.contains(&ext.as_str()) {
        return Err(AppError::Validation(format!(
            "Unsupported font format '{ext}'. Expected one of {VALID_FORMATS:?}"
        )));
    }

    if file_data.len() < 4 {
        return Err(AppError::Validation("Font file is empty".into()));
    }

    // Fail fast on the wrong content (a renamed non-font): the server
    // re-checks the same magic on upload.
    if let Some(magic) = magic_for(&ext) {
        if file_data.len() < magic.len() || &file_data[..magic.len()] != magic {
            return Err(AppError::Validation(format!(
                "Font file is not {ext} content (magic bytes mismatch)"
            )));
        }
    }
    Ok((base, ext))
}

/// Magic bytes per format, mirroring the server check.
fn magic_for(format: &str) -> Option<&'static [u8]> {
    match format {
        "ttf" => Some(&[0x00, 0x01, 0x00, 0x00]),
        "otf" => Some(b"OTTO"),
        "woff" => Some(b"wOFF"),
        "woff2" => Some(b"wOF2"),
        _ => None,
    }
}

/// The device-local download state key for one font.
pub fn font_state_key(server_id: &str) -> String {
    format!("font-state-{server_id}")
}

fn row_state(conn: &Connection, server_id: &str) -> String {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [font_state_key(server_id)],
            |r| r.get(0),
        )
        .ok();
    stored.unwrap_or_else(|| "pending".to_string())
}

fn row_to_info(conn: &Connection, row: &rusqlite::Row) -> rusqlite::Result<FontInfo> {
    let server_id: String = row.get(7)?;
    let state = row_state(conn, &server_id);
    Ok(FontInfo {
        id: row.get(0)?,
        family: row.get(1)?,
        style: row.get(2)?,
        weight: row.get(3)?,
        file_path: row.get(4)?,
        format: row.get(5)?,
        created_at: row.get(6)?,
        server_id,
        sync_state: row.get(8)?,
        sha256: row.get(9)?,
        size_bytes: row.get(10)?,
        state,
    })
}

const SELECT_COLS: &str = "id, family, style, weight, file_path, format, created_at,
    server_id, sync_state, sha256, size_bytes";

#[tauri::command]
pub fn list_fonts(db: State<DbState>) -> AppResult<Vec<FontInfo>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLS} FROM fonts WHERE sync_state <> 'deleted_pending' ORDER BY family COLLATE NOCASE"
    ))?;

    let fonts = stmt
        .query_map([], |row| row_to_info(conn, row))?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(fonts)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

#[derive(Debug, Deserialize)]
pub struct UploadFontRequest {
    pub file_name: String,
    pub file_data: Vec<u8>,
    pub family: Option<String>,
}

#[tauri::command]
pub async fn upload_font(
    app: AppHandle,
    db: State<'_, DbState>,
    file_name: String,
    file_data: Vec<u8>,
    family: Option<String>,
) -> AppResult<FontInfo> {
    store_upload(
        &app.path().app_data_dir()?.join("fonts"),
        &file_name,
        &file_data,
        family,
        &db,
    )
    .await
}

async fn store_upload(
    fonts_dir: &Path,
    file_name: &str,
    file_data: &[u8],
    family: Option<String>,
    db: &State<'_, DbState>,
) -> AppResult<FontInfo> {
    let (base, ext) = check_upload_bytes(file_name, file_data)?;

    std::fs::create_dir_all(fonts_dir)?;

    // Unique on-disk name so re-uploading a different font with the same
    // filename does not silently clobber an existing one.
    let stored = format!("{}.{}", Uuid::new_v4(), ext);
    let dest = fonts_dir.join(&stored);
    tokio::fs::write(&dest, file_data)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to write font: {e}")))?;

    let family = family
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .unwrap_or_else(|| base.trim_end_matches(&format!(".{ext}")).to_string());

    let server_id = Uuid::new_v4().to_string();
    let sha256 = sha256_hex(file_data);
    let size_bytes = file_data.len() as i64;
    let path_str = dest.to_string_lossy().to_string();
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    conn.execute(
        "INSERT INTO fonts (family, style, weight, file_path, format,
                server_id, sync_state, sha256, size_bytes)
         VALUES (?1, 'normal', '400', ?2, ?3, ?4, 'dirty', ?5, ?6)",
        rusqlite::params![family, path_str, ext, server_id, sha256, size_bytes],
    )?;

    let id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, 'ready')
         ON CONFLICT(key) DO UPDATE SET value = 'ready'",
        [font_state_key(&server_id)],
    )?;

    conn.query_row(
        &format!("SELECT {SELECT_COLS} FROM fonts WHERE id = ?1"),
        [id],
        |row| row_to_info(conn, row),
    )
    .map_err(|e| AppError::Database(e.to_string()))
}

/// Deletes a font locally as a tombstone; the engine confirms the delete
/// with the server, then forgets the row and removes the file.
#[tauri::command]
pub fn delete_font(db: State<DbState>, id: i64) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let changed = guard.connection().execute(
        "UPDATE fonts SET sync_state = 'deleted_pending' WHERE id = ?1",
        [id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("Font {id} not found")));
    }
    Ok(())
}

// ── Cache side (the sync engine's view) ─────────────────────────

pub fn apply_font_upsert(
    tx: &Transaction,
    data: &FontDataIn,
    report: &mut crate::commands::cache::ApplyReport,
) -> AppResult<()> {
    let existing: Option<(i64, String, String)> = tx
        .query_row(
            "SELECT id, sync_state, sha256 FROM fonts WHERE server_id = ?1",
            [&data.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    match existing {
        // Only synced rows take server state; dirty rows keep local
        // edits and bytes, conflicted rows wait (a later save rebases
        // them), tombstones wait for the server.
        Some((_, state, _)) if state != "synced" => {
            report.skipped_dirty += 1;
            Ok(())
        }
        Some((id, _, old_sha)) => {
            tx.execute(
                "UPDATE fonts SET family = ?1, format = ?2, size_bytes = ?3, sha256 = ?4,
                        server_revision = ?5, base_revision = ?5,
                        synced_at = datetime('now'), sync_state = 'synced'
                 WHERE id = ?6",
                rusqlite::params![
                    data.name,
                    data.format,
                    data.size_bytes,
                    data.sha256,
                    data.revision,
                    id
                ],
            )?;
            if old_sha != data.sha256 {
                tx.execute(
                    "INSERT INTO settings (key, value) VALUES (?1, 'pending')
                     ON CONFLICT(key) DO UPDATE SET value = 'pending'",
                    [font_state_key(&data.id)],
                )?;
            }
            report.applied_upserts += 1;
            Ok(())
        }
        None => {
            tx.execute(
                "INSERT INTO fonts (family, style, weight, file_path, format,
                        server_id, server_revision, base_revision,
                        sync_state, synced_at, sha256, size_bytes)
                 VALUES (?1, 'normal', '400', '', ?2, ?3, ?4, ?4, 'synced', datetime('now'), ?5, ?6)",
                rusqlite::params![
                    data.name,
                    data.format,
                    data.id,
                    data.revision,
                    data.sha256,
                    data.size_bytes
                ],
            )?;
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, 'pending')
                 ON CONFLICT(key) DO UPDATE SET value = 'pending'",
                [font_state_key(&data.id)],
            )?;
            report.applied_upserts += 1;
            Ok(())
        }
    }
}

pub fn apply_font_delete(
    tx: &Transaction,
    server_id: &str,
    report: &mut crate::commands::cache::ApplyReport,
) -> AppResult<()> {
    let existing: Option<(i64, String)> = tx
        .query_row(
            "SELECT id, sync_state FROM fonts WHERE server_id = ?1",
            [server_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    match existing {
        None => Ok(()),
        Some(_) if !font_is_synced(tx, server_id)? => {
            report.skipped_dirty += 1;
            Ok(())
        }
        Some((id, _)) => {
            // Drop the bytes with the row. The state goes back to
            // pending: if this page rolls back, the row returns and the
            // next download pass fetches the bytes again (self-healing);
            // if it commits, the orphaned key is ignored.
            let path: String =
                tx.query_row("SELECT file_path FROM fonts WHERE id = ?1", [id], |r| {
                    r.get(0)
                })?;
            tx.execute("DELETE FROM fonts WHERE id = ?1", [id])?;
            if !path.is_empty() {
                let _ = std::fs::remove_file(path);
            }
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, 'pending')
                 ON CONFLICT(key) DO UPDATE SET value = 'pending'",
                [font_state_key(server_id)],
            )?;
            report.applied_deletes += 1;
            Ok(())
        }
    }
}

fn font_is_synced(tx: &Transaction, server_id: &str) -> rusqlite::Result<bool> {
    let state: String = tx.query_row(
        "SELECT sync_state FROM fonts WHERE server_id = ?1",
        [server_id],
        |r| r.get(0),
    )?;
    Ok(state == "synced")
}

pub fn list_dirty_fonts(conn: &Connection) -> AppResult<Vec<DirtyFont>> {
    let mut stmt = conn.prepare(
        "SELECT server_id, family, base_revision
         FROM fonts WHERE sync_state = 'dirty' ORDER BY id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(DirtyFont {
                server_id: r.get(0)?,
                name: r.get(1)?,
                base_revision: r.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Records a successful metadata push: the row is clean and both
/// revisions track the server's. (The file push bumps the revision
/// again; the engine marks the final revision after the bytes land.)
pub fn mark_font_pushed(conn: &Connection, server_id: &str, revision: i64) -> AppResult<()> {
    let changed = conn.execute(
        "UPDATE fonts SET sync_state = 'synced', server_revision = ?1, base_revision = ?1
         WHERE server_id = ?2",
        rusqlite::params![revision, server_id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!(
            "no cached font with server id {server_id}"
        )));
    }
    Ok(())
}

/// Tombstoned rows waiting for the server to confirm their deletion.
pub fn list_tombstoned_fonts(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT server_id FROM fonts WHERE sync_state = 'deleted_pending'")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<Vec<String>, _>>()?)
}

/// Synced rows, for the reset pass: the engine drops every synced row
/// the full pass did not contain.
pub fn list_synced_fonts(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT server_id FROM fonts WHERE sync_state = 'synced'")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<Vec<String>, _>>()?)
}

/// Forgets a local copy outright and removes its file. Used after the
/// server confirms a delete and when a reset pass proves a synced row
/// is gone. Idempotent.
pub fn forget_font(conn: &Connection, server_id: &str) -> AppResult<bool> {
    let path: Option<String> = conn
        .query_row(
            "SELECT file_path FROM fonts WHERE server_id = ?1",
            [server_id],
            |r| r.get(0),
        )
        .ok();
    let changed = conn.execute("DELETE FROM fonts WHERE server_id = ?1", [server_id])?;
    if changed > 0 {
        if let Some(p) = path {
            if !p.is_empty() {
                let _ = std::fs::remove_file(p);
            }
        }
        return Ok(true);
    }
    Ok(false)
}

/// The stored bytes for the engine's file push. Missing file is a
/// caller bug (a dirty font always has bytes), reported as not found.
pub fn read_font_file(conn: &Connection, server_id: &str) -> AppResult<Vec<u8>> {
    let path: String = conn
        .query_row(
            "SELECT file_path FROM fonts WHERE server_id = ?1",
            [server_id],
            |r| r.get(0),
        )
        .map_err(|_| AppError::NotFound(format!("Font {server_id} not found")))?;
    std::fs::read(&path).map_err(|e| AppError::Internal(format!("Font file unreadable: {e}")))
}

/// Stores verified bytes for one font: checks the SHA-256 against the
/// row the pull applied, writes the file, and marks the row ready.
/// A hash mismatch refuses the content and keeps the pending state.
pub fn store_font_file_bytes(
    conn: &Connection,
    fonts_dir: &Path,
    server_id: &str,
    bytes: &[u8],
) -> AppResult<()> {
    let row: Option<(i64, String, String)> = conn
        .query_row(
            "SELECT id, sha256, format FROM fonts WHERE server_id = ?1",
            [server_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    let (id, expected_sha, format) = match row {
        Some(r) => r,
        None => return Err(AppError::NotFound(format!("Font {server_id} not found"))),
    };
    if expected_sha.is_empty() {
        return Err(AppError::Validation(format!(
            "Font {server_id} has no bytes on the server yet"
        )));
    }
    let actual = sha256_hex(bytes);
    if actual != expected_sha {
        return Err(AppError::Validation(format!(
            "Font {server_id} failed the SHA-256 check"
        )));
    }
    std::fs::create_dir_all(fonts_dir)?;
    // Deterministic name: re-downloads overwrite instead of piling up.
    let ext = if format.is_empty() {
        "ttf".to_string()
    } else {
        format
    };
    let dest = fonts_dir.join(format!("{server_id}.{ext}"));
    std::fs::write(&dest, bytes)?;
    let old: String = conn.query_row("SELECT file_path FROM fonts WHERE id = ?1", [id], |r| {
        r.get(0)
    })?;
    if !old.is_empty() && Path::new(&old) != dest {
        let _ = std::fs::remove_file(old);
    }
    conn.execute(
        "UPDATE fonts SET file_path = ?1, size_bytes = ?2, synced_at = datetime('now') WHERE id = ?3",
        rusqlite::params![dest.to_string_lossy().to_string(), bytes.len() as i64, id],
    )?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, 'ready')
         ON CONFLICT(key) DO UPDATE SET value = 'ready'",
        [font_state_key(server_id)],
    )?;
    Ok(())
}

fn service_config(conn: &Connection) -> Option<(String, String)> {
    let url: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'share_service_url'",
            [],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    let token: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'share_session_token'",
            [],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    match (url, token) {
        (Some(u), Some(t)) if !u.trim().is_empty() && !t.trim().is_empty() => {
            Some((u.trim().trim_end_matches('/').to_string(), t))
        }
        _ => None,
    }
}

/// Fonts whose metadata arrived but whose bytes are missing: synced
/// rows with a server hash whose download state is not ready.
fn pending_font_downloads(conn: &Connection) -> AppResult<Vec<(String,)>> {
    let mut stmt = conn.prepare(
        "SELECT f.server_id FROM fonts f
         LEFT JOIN settings s ON s.key = ('font-state-' || f.server_id)
         WHERE f.sync_state = 'synced' AND f.sha256 <> ''
           AND COALESCE(s.value, 'pending') <> 'ready'
         ORDER BY f.id",
    )?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?,)))?
        .collect::<Result<Vec<(String,)>, _>>()?;
    Ok(rows)
}

#[derive(Debug, Clone, Serialize)]
pub struct FontDownloadReport {
    pub downloaded: usize,
    pub failed: usize,
}

/// Downloads every pending font file in the background: fetches the
/// bytes from the service, checks the SHA-256 into the cache folder,
/// and marks each row ready (or errored, for the next run to retry).
/// Quietly does nothing when signed out — the rows stay pending.
/// The lock is taken per font, never across a network await.
pub async fn download_pending_fonts(
    db: &DbState,
    fonts_dir: &Path,
    client: &reqwest::Client,
) -> AppResult<FontDownloadReport> {
    let (base_url, token, pending): (String, String, Vec<String>) = {
        let guard = db
            .lock()
            .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
        let conn = guard.connection();
        let Some((base_url, token)) = service_config(conn) else {
            return Ok(FontDownloadReport {
                downloaded: 0,
                failed: 0,
            });
        };
        let pending = pending_font_downloads(conn)?
            .into_iter()
            .map(|(id,)| id)
            .collect();
        (base_url, token, pending)
    };
    let mut report = FontDownloadReport {
        downloaded: 0,
        failed: 0,
    };
    for server_id in pending {
        let url = format!("{base_url}/v2/fonts/{server_id}/file");
        // Fetch outside the lock: downloads must not block the UI's
        // database access.
        let fetched: Result<Vec<u8>, ()> = async {
            let response = client
                .get(&url)
                .bearer_auth(&token)
                .send()
                .await
                .map_err(|_| ())?;
            let status_ok = response.error_for_status().map_err(|_| ())?;
            status_ok.bytes().await.map(|b| b.to_vec()).map_err(|_| ())
        }
        .await;
        let guard = db
            .lock()
            .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
        let conn = guard.connection();
        match fetched {
            Ok(bytes) => match store_font_file_bytes(conn, fonts_dir, &server_id, &bytes) {
                Ok(()) => report.downloaded += 1,
                Err(_) => {
                    mark_font_state(conn, &server_id, "error");
                    report.failed += 1;
                }
            },
            Err(()) => {
                mark_font_state(conn, &server_id, "error");
                report.failed += 1;
            }
        }
    }
    Ok(report)
}

fn mark_font_state(conn: &Connection, server_id: &str, state: &str) {
    let _ = conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![font_state_key(server_id), state],
    );
}

// ── Tauri wrappers: lock, delegate, no logic ────────────────────

#[tauri::command]
pub fn cache_list_dirty_fonts(db: State<DbState>) -> AppResult<Vec<DirtyFont>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    list_dirty_fonts(guard.connection())
}

#[tauri::command]
pub fn cache_mark_font_pushed(
    db: State<DbState>,
    server_id: String,
    revision: i64,
) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    mark_font_pushed(guard.connection(), &server_id, revision)
}

#[tauri::command]
pub fn cache_list_tombstoned_fonts(db: State<DbState>) -> AppResult<Vec<String>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    list_tombstoned_fonts(guard.connection())
}

#[tauri::command]
pub fn cache_list_synced_fonts(db: State<DbState>) -> AppResult<Vec<String>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    list_synced_fonts(guard.connection())
}

#[tauri::command]
pub fn cache_forget_font(db: State<DbState>, server_id: String) -> AppResult<bool> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    forget_font(guard.connection(), &server_id)
}

#[tauri::command]
pub fn cache_read_font_file(db: State<DbState>, server_id: String) -> AppResult<Vec<u8>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    read_font_file(guard.connection(), &server_id)
}

#[tauri::command]
pub async fn cache_download_pending_fonts(
    app: AppHandle,
    db: State<'_, DbState>,
) -> AppResult<FontDownloadReport> {
    let fonts_dir = app.path().app_data_dir()?.join("fonts");
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| AppError::Internal(format!("HTTP client failed: {e}")))?;
    download_pending_fonts(&db, &fonts_dir, &client).await
}

/// Test seam: deterministic file storage without Tauri state.
pub fn fonts_dir_for_tests() -> PathBuf {
    std::env::temp_dir().join(format!("pn-fonts-{}", Uuid::new_v4()))
}
