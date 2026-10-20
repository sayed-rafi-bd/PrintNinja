//! Local sync cache commands (REFACTORING.md section 6, Phase 3).
//!
//! The cache is the app's source of truth for reads; the sync engine in
//! `src/lib/sync/` moves records between it and the hosted API. Every
//! mutating command here is a plain function over `&Connection` (plus a
//! thin `#[tauri::command]` wrapper) so the shared `cache_cases.json`
//! fixtures drive both the Rust tests and the TypeScript fake agent.

use crate::db::DbState;
use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

/// One record from `GET /v2/sync/changes`, as the engine passes it in.
/// `data` stays unparsed until the entity is known, so an unknown entity
/// fails on its name rather than on its shape.
#[derive(Debug, Clone, Deserialize)]
pub struct SyncChangeIn {
    pub seq: i64,
    pub entity: String,
    /// "upsert" | "delete". Anything else is rejected, never ignored.
    pub op: String,
    /// Present for upserts; parsed as `TemplateDataIn` for templates.
    pub data: Option<serde_json::Value>,
    /// Server UUID for deletes (the setting key for settings, Phase 4).
    pub id: Option<String>,
}

/// A synced template record. Field names match the sync wire shape;
/// `*_mm` arrive as floats and are rounded to the local INTEGER columns.
#[derive(Debug, Clone, Deserialize)]
pub struct TemplateDataIn {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub summary: String,
    pub page_w_mm: f64,
    pub page_h_mm: f64,
    pub body: String,
    #[serde(default)]
    pub css: String,
    #[serde(default)]
    pub readme: String,
    pub revision: i64,
    pub published_at: Option<String>,
    pub updated_at: String,
}

/// What `cache_apply_changes` did. Counts drive the sync engine's logging,
/// not control flow — a page applies atomically or not at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApplyReport {
    pub applied_upserts: usize,
    pub applied_deletes: usize,
    pub skipped_dirty: usize,
}

/// Applies one sync page atomically: upserts, deletions and the new
/// cursor commit together, so a crash in the middle repeats the page
/// instead of skipping it. Dirty rows survive untouched (a push that was
/// applied but whose response was lost converges through the server's
/// replay); deletes of dirty rows are skipped for the same reason.
/// Unknown entities and ops are rejected, never silently skipped.
pub fn apply_changes(
    conn: &Connection,
    changes: &[SyncChangeIn],
    new_cursor: &str,
) -> AppResult<ApplyReport> {
    let tx = conn.unchecked_transaction()?;
    let mut report = ApplyReport {
        applied_upserts: 0,
        applied_deletes: 0,
        skipped_dirty: 0,
    };
    for change in changes {
        match change.op.as_str() {
            "upsert" => {
                if change.entity != "template" {
                    return Err(AppError::Validation(format!(
                        "unsupported sync entity '{}'",
                        change.entity
                    )));
                }
                let data_value = change
                    .data
                    .as_ref()
                    .ok_or_else(|| AppError::Validation("sync upsert without data".to_string()))?;
                let data: TemplateDataIn = serde_json::from_value(data_value.clone())
                    .map_err(|e| AppError::Validation(format!("bad sync record: {e}")))?;
                apply_upsert(&tx, &data, &mut report)?;
            }
            "delete" => {
                let id = change
                    .id
                    .as_deref()
                    .ok_or_else(|| AppError::Validation("sync delete without id".to_string()))?;
                apply_delete(&tx, &change.entity, id, &mut report)?;
            }
            other => {
                return Err(AppError::Validation(format!(
                    "unsupported sync op '{other}'"
                )))
            }
        }
    }
    tx.execute(
        "INSERT INTO sync_state (id, cursor, last_pull_at, last_error)
         VALUES (1, ?1, datetime('now'), NULL)
         ON CONFLICT(id) DO UPDATE SET cursor = ?1, last_pull_at = datetime('now'), last_error = NULL",
        [new_cursor],
    )?;
    tx.commit()?;
    Ok(report)
}

fn apply_upsert(
    tx: &rusqlite::Transaction,
    data: &TemplateDataIn,
    report: &mut ApplyReport,
) -> AppResult<()> {
    let existing: Option<(i64, String)> = tx
        .query_row(
            "SELECT id, sync_state FROM templates WHERE server_id = ?1",
            [&data.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    match existing {
        Some((_, state)) if state == "dirty" => {
            report.skipped_dirty += 1;
            Ok(())
        }
        Some((id, _)) => {
            let page_w = data.page_w_mm.round() as i64;
            let page_h = data.page_h_mm.round() as i64;
            let orientation = if page_w > page_h {
                "landscape"
            } else {
                "portrait"
            };
            tx.execute(
                "UPDATE templates SET name = ?1, summary = ?2, page_w_mm = ?3, page_h_mm = ?4,
                        orientation = ?5, readme = ?6, published_at = ?7,
                        server_revision = ?8, base_revision = ?8, synced_at = datetime('now'),
                        sync_state = 'synced', updated_at = ?9
                 WHERE id = ?10",
                rusqlite::params![
                    data.name,
                    data.summary,
                    page_w,
                    page_h,
                    orientation,
                    data.readme,
                    data.published_at,
                    data.revision,
                    data.updated_at,
                    id
                ],
            )?;
            let version_no: i64 = tx.query_row(
                "SELECT COALESCE(MAX(version_no), 0) + 1 FROM template_versions WHERE template_id = ?1",
                [id],
                |r| r.get(0),
            )?;
            let version_id: i64 = tx.query_row(
                "INSERT INTO template_versions (template_id, version_no, html, css, created_by)
                 VALUES (?1, ?2, ?3, ?4, 'sync') RETURNING id",
                rusqlite::params![id, version_no, data.body, data.css],
                |r| r.get(0),
            )?;
            tx.execute(
                "UPDATE templates SET current_version_id = ?1 WHERE id = ?2",
                rusqlite::params![version_id, id],
            )?;
            prune_versions(tx, id)?;
            report.applied_upserts += 1;
            Ok(())
        }
        None => {
            let page_w = data.page_w_mm.round() as i64;
            let page_h = data.page_h_mm.round() as i64;
            let orientation = if page_w > page_h {
                "landscape"
            } else {
                "portrait"
            };
            tx.execute(
                "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation, readme, summary,
                        published_at, updated_at, server_id, server_revision, base_revision,
                        sync_state, kind, owner_handle, synced_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, 'synced', 'own', NULL, datetime('now'))",
                rusqlite::params![
                    data.name,
                    page_w,
                    page_h,
                    orientation,
                    data.readme,
                    data.summary,
                    data.published_at,
                    data.updated_at,
                    data.id,
                    data.revision,
                ],
            )?;
            let template_id = tx.last_insert_rowid();
            let version_id: i64 = tx.query_row(
                "INSERT INTO template_versions (template_id, version_no, html, css, created_by)
                 VALUES (?1, 1, ?2, ?3, 'sync') RETURNING id",
                rusqlite::params![template_id, data.body, data.css],
                |r| r.get(0),
            )?;
            tx.execute(
                "UPDATE templates SET current_version_id = ?1 WHERE id = ?2",
                rusqlite::params![version_id, template_id],
            )?;
            report.applied_upserts += 1;
            Ok(())
        }
    }
}

fn apply_delete(
    tx: &rusqlite::Transaction,
    entity: &str,
    id: &str,
    report: &mut ApplyReport,
) -> AppResult<()> {
    if entity != "template" {
        return Err(AppError::Validation(format!(
            "unsupported sync entity '{entity}'"
        )));
    }
    let existing: Option<(i64, String)> = tx
        .query_row(
            "SELECT id, sync_state FROM templates WHERE server_id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    match existing {
        // Already gone (or never arrived): deletes are idempotent.
        None => Ok(()),
        // A dirty row survives: pushing it later recreates the server copy.
        Some(_) if local_is_dirty(tx, id)? => {
            report.skipped_dirty += 1;
            Ok(())
        }
        Some((local_id, _)) => {
            tx.execute("DELETE FROM templates WHERE id = ?1", [local_id])?;
            report.applied_deletes += 1;
            Ok(())
        }
    }
}

fn local_is_dirty(tx: &rusqlite::Transaction, server_id: &str) -> rusqlite::Result<bool> {
    let state: String = tx.query_row(
        "SELECT sync_state FROM templates WHERE server_id = ?1",
        [server_id],
        |r| r.get(0),
    )?;
    Ok(state == "dirty")
}

/// The local versions table is a read cache: keep the newest 20 per
/// template so offline diffs keep working without unbounded growth.
fn prune_versions(tx: &rusqlite::Transaction, template_id: i64) -> rusqlite::Result<()> {
    tx.execute(
        "DELETE FROM template_versions
         WHERE template_id = ?1 AND id NOT IN (
             SELECT id FROM template_versions WHERE template_id = ?1 ORDER BY version_no DESC LIMIT 20
         )",
        [template_id],
    )?;
    Ok(())
}

/// The one sync-state row, or blanks when no pull has happened yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SyncState {
    pub account_handle: Option<String>,
    pub server_url: Option<String>,
    pub cursor: String,
    pub last_pull_at: Option<String>,
    pub last_error: Option<String>,
}

type SyncStateRow = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

pub fn get_sync_state(conn: &Connection) -> AppResult<SyncState> {
    let row: Option<SyncStateRow> =
        conn.query_row(
            "SELECT account_handle, server_url, cursor, last_pull_at, last_error FROM sync_state WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .ok();
    match row {
        Some((account_handle, server_url, cursor, last_pull_at, last_error)) => Ok(SyncState {
            account_handle,
            server_url,
            cursor: cursor.unwrap_or_default(),
            last_pull_at,
            last_error,
        }),
        None => Ok(SyncState {
            account_handle: None,
            server_url: None,
            cursor: String::new(),
            last_pull_at: None,
            last_error: None,
        }),
    }
}

/// Rows waiting to be pushed: id, server id (null when never pushed),
/// name and the current version's HTML/CSS plus the base revision the
/// next push must send as `if_revision`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DirtyTemplate {
    pub id: i64,
    pub server_id: Option<String>,
    pub name: String,
    pub html: String,
    pub css: String,
    pub base_revision: Option<i64>,
}

pub fn list_dirty(conn: &Connection) -> AppResult<Vec<DirtyTemplate>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.server_id, t.name, v.html, v.css, t.base_revision
         FROM templates t LEFT JOIN template_versions v ON v.id = t.current_version_id
         WHERE t.sync_state = 'dirty'
         ORDER BY t.id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(DirtyTemplate {
            id: r.get(0)?,
            server_id: r.get(1)?,
            name: r.get(2)?,
            html: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            css: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
            base_revision: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Records a successful push: the row is clean and both revisions track
/// the server's. Called by the sync engine, not by editing commands.
pub fn mark_pushed(conn: &Connection, server_id: &str, revision: i64) -> AppResult<()> {
    let changed = conn.execute(
        "UPDATE templates SET sync_state = 'synced', server_revision = ?1, base_revision = ?1
         WHERE server_id = ?2",
        rusqlite::params![revision, server_id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!(
            "no cached template with server id {server_id}"
        )));
    }
    Ok(())
}

// ── Tauri wrappers: lock, delegate, no logic ─────────────────────────

#[tauri::command]
pub fn cache_apply_changes(
    db: State<'_, DbState>,
    changes: Vec<SyncChangeIn>,
    new_cursor: String,
) -> AppResult<ApplyReport> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    apply_changes(guard.connection(), &changes, &new_cursor)
}

#[tauri::command]
pub fn cache_get_sync_state(db: State<'_, DbState>) -> AppResult<SyncState> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    get_sync_state(guard.connection())
}

#[tauri::command]
pub fn cache_list_dirty(db: State<'_, DbState>) -> AppResult<Vec<DirtyTemplate>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    list_dirty(guard.connection())
}

#[tauri::command]
pub fn cache_mark_pushed(
    db: State<'_, DbState>,
    server_id: String,
    revision: i64,
) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    mark_pushed(guard.connection(), &server_id, revision)
}
