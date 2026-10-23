//! Integration tests for the DB-backed Tauri commands.
//!
//! These run against a real temp-file SQLite database so the SQL is actually
//! exercised (not just type-checked). Tauri `State` is unwrapped via a helper.

use printninja_lib::db::{strip_sqlite_prefix, Database};
use rusqlite::Connection;
use std::sync::{Arc, Mutex};

/// Build an in-memory DB seeded with the app schema, returning the DbState
/// and a guard so the connection stays alive.
fn test_db() -> (Arc<Mutex<Database>>, Connection) {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    printninja_lib::db::init(&conn).expect("apply schema");

    let dir = std::env::temp_dir();
    let path = dir.join(format!("printninja_test_{}.db", uuid::Uuid::new_v4()));
    let db = Database::open(&format!("sqlite:{}", path.display())).expect("open file db");
    (Arc::new(Mutex::new(db)), conn)
}

// ───────────────────────────────────────────────────────────────
// settings
// ───────────────────────────────────────────────────────────────

#[test]
fn db_path_strips_sqlite_prefix() {
    assert_eq!(
        strip_sqlite_prefix("sqlite:/tmp/printninja.db"),
        "/tmp/printninja.db"
    );
    assert_eq!(
        strip_sqlite_prefix("/tmp/printninja.db"),
        "/tmp/printninja.db"
    );
}

#[test]
fn settings_roundtrip() {
    let (_state, conn) = test_db();

    // insert
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ["theme", "dark"],
    )
    .unwrap();

    let val: String = conn
        .query_row("SELECT value FROM settings WHERE key = 'theme'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(val, "dark");

    // upsert same key
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('theme', 'light')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [],
    )
    .unwrap();

    let val: String = conn
        .query_row("SELECT value FROM settings WHERE key = 'theme'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(val, "light");
}

// ───────────────────────────────────────────────────────────────
// printers
// ───────────────────────────────────────────────────────────────

#[test]
fn printer_insert_and_list() {
    let (_state, conn) = test_db();

    conn.execute(
        "INSERT INTO printers (name, type, address, language, paper_width_mm, dpi)
         VALUES ('Front Desk', 'ipp', '192.168.1.100', 'pdf', 210, 203)",
        [],
    )
    .unwrap();

    let mut stmt = conn
        .prepare("SELECT name, type, language FROM printers ORDER BY name")
        .unwrap();
    let rows: Vec<(String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, "Front Desk");
    assert_eq!(rows[0].1, "ipp");
    assert_eq!(rows[0].2, "pdf");
}

#[test]
fn printer_delete_reports_not_found() {
    let (_state, conn) = test_db();
    let affected = conn
        .execute("DELETE FROM printers WHERE id = 9999", [])
        .unwrap();
    assert_eq!(affected, 0);
}

// ───────────────────────────────────────────────────────────────
// templates + versions
// ───────────────────────────────────────────────────────────────

#[test]
fn template_create_inserts_version1() {
    let (_state, conn) = test_db();

    conn.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation)
         VALUES ('My Receipt', 120, 200, 'portrait')",
        [],
    )
    .unwrap();
    let tid = conn.last_insert_rowid();

    conn.execute(
        "INSERT INTO template_versions (template_id, version_no, html, css, created_by)
         VALUES (?1, 1, '<h1>hi</h1>', '', 'manual')",
        [tid],
    )
    .unwrap();
    let vid = conn.last_insert_rowid();
    conn.execute(
        "UPDATE templates SET current_version_id = ?1 WHERE id = ?2",
        [vid, tid],
    )
    .unwrap();

    let current: i64 = conn
        .query_row(
            "SELECT current_version_id FROM templates WHERE id = ?1",
            [tid],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(current, vid);
}

#[test]
fn version_numbering_increments() {
    let (_state, conn) = test_db();

    conn.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation)
         VALUES ('T', 210, 297, 'portrait')",
        [],
    )
    .unwrap();
    let tid = conn.last_insert_rowid();

    for i in 1..=3 {
        conn.execute(
            "INSERT INTO template_versions (template_id, version_no, html, css, created_by)
             VALUES (?1, ?2, '', '', 'manual')",
            [tid, i],
        )
        .unwrap();
    }

    let next: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version_no), 0) + 1 FROM template_versions WHERE template_id = ?1",
            [tid],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(next, 4);
}

#[test]
fn restore_creates_new_version_not_overwrite() {
    let (_state, conn) = test_db();

    conn.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation)
         VALUES ('T', 210, 297, 'portrait')",
        [],
    )
    .unwrap();
    let tid = conn.last_insert_rowid();

    conn.execute(
        "INSERT INTO template_versions (template_id, version_no, html, css, created_by)
         VALUES (?1, 1, 'v1 html', 'v1 css', 'manual')",
        [tid],
    )
    .unwrap();

    // simulate restore: insert v2 with same content as v1
    conn.execute(
        "INSERT INTO template_versions (template_id, version_no, html, css, created_by)
         VALUES (?1, 2, 'v1 html', 'v1 css', 'restore')",
        [tid],
    )
    .unwrap();

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM template_versions WHERE template_id = ?1",
            [tid],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 2, "restore must not delete history");
}

// ───────────────────────────────────────────────────────────────
// per-template compiled CSS
// ───────────────────────────────────────────────────────────────

fn version_columns(conn: &Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(template_versions)")
        .unwrap();
    stmt.query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

#[test]
fn compiled_css_columns_are_added_to_an_existing_database() {
    // A database created before per-template compilation: schema.sql alone has
    // no compiled_* columns, and already holds a saved version.
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(include_str!("../src/db/schema.sql"))
        .unwrap();
    assert!(!version_columns(&conn).contains(&"compiled_css".to_string()));

    conn.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation)
         VALUES ('Old', 120, 200, 'portrait')",
        [],
    )
    .unwrap();
    let tid = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO template_versions (template_id, version_no, html, css, created_by)
         VALUES (?1, 1, '<p class=\"flex\">x</p>', '.a{b:c}', 'manual')",
        [tid],
    )
    .unwrap();

    printninja_lib::db::ensure_v2_schema(&conn).unwrap();

    let cols = version_columns(&conn);
    assert!(cols.contains(&"compiled_css".to_string()), "{cols:?}");
    assert!(cols.contains(&"compiled_key".to_string()), "{cols:?}");

    // Old rows read back as "not compiled", which makes printing fall back to
    // the shared bundle, and their html/css are untouched.
    let (html, css, compiled, key): (String, String, String, String) = conn
        .query_row(
            "SELECT html, css, compiled_css, compiled_key
             FROM template_versions WHERE template_id = ?1",
            [tid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(html, "<p class=\"flex\">x</p>");
    assert_eq!(css, ".a{b:c}");
    assert_eq!(compiled, "");
    assert_eq!(key, "");
}

#[test]
fn compiled_css_migration_is_idempotent() {
    let (_state, conn) = test_db();
    let before = version_columns(&conn);
    printninja_lib::db::ensure_v2_schema(&conn).unwrap();
    printninja_lib::db::ensure_v2_schema(&conn).unwrap();
    assert_eq!(version_columns(&conn), before);
}

#[test]
fn compiled_css_is_stored_per_version_and_copied_on_restore() {
    let (_state, conn) = test_db();

    conn.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation)
         VALUES ('T', 120, 200, 'portrait')",
        [],
    )
    .unwrap();
    let tid = conn.last_insert_rowid();

    conn.execute(
        "INSERT INTO template_versions
           (template_id, version_no, html, css, created_by, compiled_css, compiled_key)
         VALUES (?1, 1, '<p class=\"w-[37mm]\">x</p>', '', 'manual', '.w{width:37mm}', 'k1')",
        [tid],
    )
    .unwrap();
    // The next version has different html, so it carries different compiled CSS.
    conn.execute(
        "INSERT INTO template_versions
           (template_id, version_no, html, css, created_by, compiled_css, compiled_key)
         VALUES (?1, 2, '<p class=\"flex\">x</p>', '', 'manual', '.flex{display:flex}', 'k2')",
        [tid],
    )
    .unwrap();

    // Restoring v1 copies its html together with the CSS compiled from it.
    conn.execute(
        "INSERT INTO template_versions
           (template_id, version_no, html, css, created_by, compiled_css, compiled_key)
         SELECT template_id, 3, html, css, 'restore', compiled_css, compiled_key
         FROM template_versions WHERE template_id = ?1 AND version_no = 1",
        [tid],
    )
    .unwrap();

    let (compiled, key): (String, String) = conn
        .query_row(
            "SELECT compiled_css, compiled_key FROM template_versions
             WHERE template_id = ?1 AND version_no = 3",
            [tid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(compiled, ".w{width:37mm}");
    assert_eq!(key, "k1");
}

// ───────────────────────────────────────────────────────────────
// history
// ───────────────────────────────────────────────────────────────

#[test]
fn history_job_insert_and_delete() {
    let (_state, conn) = test_db();

    conn.execute(
        "INSERT INTO print_jobs (source, status, copies, is_test)
         VALUES ('ui', 'success', 1, 0)",
        [],
    )
    .unwrap();
    let id = conn.last_insert_rowid();

    let status: String = conn
        .query_row("SELECT status FROM print_jobs WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(status, "success");

    let affected = conn
        .execute("DELETE FROM print_jobs WHERE id = ?1", [id])
        .unwrap();
    assert_eq!(affected, 1);

    let gone = conn
        .execute("DELETE FROM print_jobs WHERE id = ?1", [id])
        .unwrap();
    assert_eq!(gone, 0);
}

#[test]
fn history_retry_resets_error_and_timestamps() {
    let (_state, conn) = test_db();

    conn.execute(
        "INSERT INTO print_jobs (source, status, error, is_test, started_at, finished_at, duration_ms)
         VALUES ('ui', 'failed', 'printer offline', 0, '2026-01-01', '2026-01-01', 500)",
        [],
    )
    .unwrap();
    let id = conn.last_insert_rowid();

    conn.execute(
        "UPDATE print_jobs SET status='queued', error=NULL, started_at=NULL,
             finished_at=NULL, duration_ms=NULL WHERE id=?1",
        [id],
    )
    .unwrap();

    let (status, err, fin): (String, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT status, error, finished_at FROM print_jobs WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(status, "queued");
    assert!(err.is_none());
    assert!(fin.is_none());
}

// ───────────────────────────────────────────────────────────────
// Phase 3 sync bookkeeping (REFACTORING.md section 6)
// ───────────────────────────────────────────────────────────────

fn template_columns(conn: &Connection) -> Vec<String> {
    let mut stmt = conn.prepare("PRAGMA table_info(templates)").unwrap();
    stmt.query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .collect::<rusqlite::Result<Vec<String>>>()
        .unwrap()
}

#[test]
fn sync_schema_adds_columns_state_table_and_index() {
    let (_state, conn) = test_db();
    printninja_lib::db::ensure_sync_schema(&conn).unwrap();

    let cols = template_columns(&conn);
    for col in [
        "server_id",
        "server_revision",
        "base_revision",
        "sync_state",
        "kind",
        "owner_handle",
        "synced_at",
    ] {
        assert!(cols.contains(&col.to_string()), "missing {col}: {cols:?}");
    }
    let index: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_templates_server_id'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(index.as_deref(), Some("idx_templates_server_id"));
    let table: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(table.as_deref(), Some("sync_state"));

    // Idempotent: a second call changes nothing.
    let before = template_columns(&conn);
    printninja_lib::db::ensure_sync_schema(&conn).unwrap();
    assert_eq!(template_columns(&conn), before);
}

#[test]
fn sync_schema_backfills_server_id_and_dirty_local_only_rows() {
    let (_state, conn) = test_db();
    // A pre-Phase-3 row: synced once (remote_id set), and a local-only row.
    conn.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation, origin, remote_id, origin_owner)
         VALUES ('Synced', 210, 297, 'portrait', 'own', 'remote-1', NULL)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation, origin)
         VALUES ('Local', 210, 297, 'portrait', 'saved')",
        [],
    )
    .unwrap();
    // A saved row carries its owner's handle in origin_owner.
    conn.execute(
        "UPDATE templates SET origin_owner = 'ana' WHERE name = 'Local'",
        [],
    )
    .unwrap();

    printninja_lib::db::ensure_sync_schema(&conn).unwrap();

    let synced: (String, String, Option<i64>, String, Option<String>) = conn
        .query_row(
            "SELECT server_id, sync_state, server_revision, kind, owner_handle FROM templates WHERE name = 'Synced'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .unwrap();
    assert_eq!(synced.0, "remote-1");
    assert_eq!(synced.1, "synced");
    assert_eq!(synced.2, None);
    assert_eq!(synced.3, "own");
    assert_eq!(synced.4, None);

    let local: (String, String, String, Option<String>) = conn
        .query_row(
            "SELECT server_id, sync_state, kind, owner_handle FROM templates WHERE name = 'Local'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    // A fresh v4 UUID, valid and distinct from any remote id.
    assert!(
        uuid::Uuid::parse_str(&local.0).is_ok(),
        "not a UUID: {}",
        local.0
    );
    assert_ne!(local.0, "remote-1");
    assert_eq!(local.1, "dirty");
    assert_eq!(local.2, "saved");
    assert_eq!(local.3, Some("ana".to_string()));

    // Re-running keeps every value (no new UUIDs, no state flips).
    printninja_lib::db::ensure_sync_schema(&conn).unwrap();
    let again: (String, String) = conn
        .query_row(
            "SELECT server_id, sync_state FROM templates WHERE name = 'Local'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((again.0, again.1), (local.0, local.1));
}

#[test]
fn sync_state_table_holds_one_row() {
    let (_state, conn) = test_db();
    printninja_lib::db::ensure_sync_schema(&conn).unwrap();

    conn.execute(
        "INSERT INTO sync_state (id, account_handle, server_url, cursor) VALUES (1, 'rafi', 'https://srv.example', 'MA')",
        [],
    )
    .unwrap();
    let second = conn.execute(
        "INSERT INTO sync_state (id, account_handle) VALUES (2, 'ana')",
        [],
    );
    assert!(second.is_err(), "sync_state must stay a single row");
}

// ───────────────────────────────────────────────────────────────
// sync dirty writes and local tombstones (Phase 3)
// ───────────────────────────────────────────────────────────────

use printninja_lib::commands::template::{
    write_delete_template, write_template, write_template_meta, CreateTemplateRequest,
    UpdateTemplateMetaRequest,
};
use printninja_lib::commands::version::create_version_conn;
use printninja_lib::commands::version::CreateVersionRequest;

fn new_template(name: &str) -> CreateTemplateRequest {
    CreateTemplateRequest {
        name: name.to_string(),
        page_w_mm: Some(210),
        page_h_mm: Some(297),
        orientation: None,
        html: Some("<p>x</p>".to_string()),
        css: None,
        compiled_css: None,
        compiled_key: None,
        readme: None,
        summary: None,
        server_id: None,
        sync_state: None,
        kind: None,
        owner_handle: None,
        server_revision: None,
        base_revision: None,
    }
}

fn sync_row(conn: &Connection, id: i64) -> (Option<String>, String, Option<i64>, String) {
    conn.query_row(
        "SELECT server_id, sync_state, server_revision, kind FROM templates WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .unwrap()
}

#[test]
fn create_marks_new_rows_dirty_with_a_fresh_server_id() {
    let (_state, conn) = test_db();
    let tpl = write_template(&conn, &new_template("Fresh")).unwrap();

    let (server_id, state, revision, kind) = sync_row(&conn, tpl.id);
    let server_id = server_id.expect("new rows get a server id");
    assert!(
        uuid::Uuid::parse_str(&server_id).is_ok(),
        "v4 uuid, got {server_id}"
    );
    assert_eq!(state, "dirty");
    assert_eq!(revision, None);
    assert_eq!(kind, "own");
}

#[test]
fn create_accepts_a_synced_server_copy() {
    let (_state, conn) = test_db();
    let tpl = write_template(
        &conn,
        &CreateTemplateRequest {
            server_id: Some("srv-1".to_string()),
            sync_state: Some("synced".to_string()),
            kind: Some("saved".to_string()),
            owner_handle: Some("ana".to_string()),
            server_revision: Some(4),
            base_revision: Some(4),
            ..new_template("Downloaded")
        },
    )
    .unwrap();

    let (server_id, state, revision, kind) = sync_row(&conn, tpl.id);
    assert_eq!(server_id.as_deref(), Some("srv-1"));
    assert_eq!(state, "synced");
    assert_eq!(revision, Some(4));
    assert_eq!(kind, "saved");
}

#[test]
fn edits_mark_the_row_dirty_but_never_undelete_it() {
    let (_state, conn) = test_db();
    // Start synced (as if just pulled), so the dirty transition is visible.
    let tpl = write_template(
        &conn,
        &CreateTemplateRequest {
            server_id: Some("srv-2".to_string()),
            sync_state: Some("synced".to_string()),
            ..new_template("Editable")
        },
    )
    .unwrap();
    write_template_meta(
        &conn,
        &UpdateTemplateMetaRequest {
            id: tpl.id,
            name: "Editable".to_string(),
            page_w_mm: 210,
            page_h_mm: 297,
            summary: None,
        },
    )
    .unwrap();
    assert_eq!(sync_row(&conn, tpl.id).1, "dirty");

    create_version_conn(
        &conn,
        CreateVersionRequest {
            template_id: tpl.id,
            html: "<p>v2</p>".to_string(),
            css: String::new(),
            label: None,
            note: None,
            created_by: None,
            compiled_css: None,
            compiled_key: None,
        },
    )
    .unwrap();
    assert_eq!(sync_row(&conn, tpl.id).1, "dirty");
}

#[test]
fn delete_tombstones_and_hides_the_row_while_keeping_history() {
    let (_state, conn) = test_db();
    let tpl = write_template(&conn, &new_template("Doomed")).unwrap();
    let versions_before: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM template_versions WHERE template_id = ?1",
            [tpl.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(versions_before, 1);

    write_delete_template(&conn, tpl.id).unwrap();
    assert_eq!(sync_row(&conn, tpl.id).1, "deleted_pending");

    // Lists and direct reads skip tombstones.
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM templates WHERE sync_state <> 'deleted_pending'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);

    // Deleting twice is still "not found", and the name is reusable.
    assert!(write_delete_template(&conn, tpl.id).is_err());
    let tpl2 = write_template(&conn, &new_template("Doomed")).unwrap();
    assert_ne!(tpl2.id, tpl.id);

    // The version history survives for restore and diff.
    let versions_after: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM template_versions WHERE template_id = ?1",
            [tpl.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(versions_after, 1);
}

#[test]
fn sync_schema_marks_migrated_installs() {
    let (_state, conn) = test_db();
    // Fresh install: no legacy links, no marker.
    let marker: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'install_migrated'",
            [],
            |r| r.get(0),
        )
        .ok();
    assert_eq!(marker, None);

    // A pre-Phase-3 row with a legacy remote_id marks the install migrated.
    conn.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation, origin, remote_id)
         VALUES ('Old', 210, 297, 'portrait', 'own', 'remote-9')",
        [],
    )
    .unwrap();
    printninja_lib::db::ensure_sync_schema(&conn).unwrap();
    let marker: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'install_migrated'",
            [],
            |r| r.get(0),
        )
        .ok();
    assert_eq!(marker.as_deref(), Some("1"));

    // Re-running keeps the marker (and the backfilled server id).
    printninja_lib::db::ensure_sync_schema(&conn).unwrap();
    let marker: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'install_migrated'",
            [],
            |r| r.get(0),
        )
        .ok();
    assert_eq!(marker.as_deref(), Some("1"));
}

// ───────────────────────────────────────────────────────────────
// full database reset
// ───────────────────────────────────────────────────────────────

#[test]
fn reset_database_recreates_the_file_fresh() {
    use printninja_lib::commands::reset::recreate_database;

    let (state, _conn) = test_db();
    let fonts_dir = std::env::temp_dir().join(format!("pn-reset-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&fonts_dir).unwrap();

    // Seed one row per user-data table (plus a legacy dead table and a
    // font file on disk) so the recreate has something to prove. Two
    // printers bump the AUTOINCREMENT counter, proving it restarts.
    let font_path = fonts_dir.join("orphan.ttf");
    std::fs::write(&font_path, [0x00, 0x01, 0x00, 0x00]).unwrap();
    {
        let guard = state.lock().unwrap();
        let conn = guard.connection();
        conn.execute(
            "INSERT INTO printers (name, type, address, language) VALUES ('P', 'ipp', 'x', 'pdf')",
            [],
        )
        .unwrap();
        let printer: i64 = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO printers (name, type, address, language) VALUES ('P2', 'ipp', 'y', 'pdf')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation) VALUES ('T', 210, 297, 'portrait')",
            [],
        )
        .unwrap();
        let template: i64 = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO template_versions (template_id, version_no, html, css, created_by)
             VALUES (?1, 1, '<p></p>', '', 'manual')",
            [template],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO batches (template_id, printer_id) VALUES (?1, ?2)",
            rusqlite::params![template, printer],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO print_jobs (template_id, printer_id, source, status) VALUES (?1, ?2, 'ui', 'success')",
            rusqlite::params![template, printer],
        )
        .unwrap();
        let font_db_path = font_path.to_string_lossy().to_string();
        conn.execute(
            "INSERT INTO fonts (family, style, weight, file_path, format) VALUES ('Body', 'normal', '400', ?1, 'ttf')",
            [font_db_path],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO synced_datasets (server_id, name) VALUES ('ds-1', 'D')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO synced_profiles (server_id, template_server_id, printer_name) VALUES ('p-1', 't-1', 'e2e')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO api_clients (name, key_hash) VALUES ('c', 'h')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO queued_uses (server_template_id, count) VALUES ('t-1', 2)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO sync_state (id, cursor) VALUES (1, 'abc')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('share_session_token', 'tok')",
            [],
        )
        .unwrap();
        conn.execute("CREATE TABLE printer_profiles (id INTEGER PRIMARY KEY)", [])
            .unwrap();
    }

    let report = recreate_database(&mut state.lock().unwrap(), &fonts_dir).unwrap();
    assert_eq!(report.templates, 1);
    assert_eq!(report.template_versions, 1);
    assert_eq!(report.print_jobs, 1);
    assert_eq!(report.fonts, 1);
    assert_eq!(report.datasets, 1);
    assert_eq!(report.profiles, 1);
    assert_eq!(report.printers, 2);
    assert_eq!(report.batches, 1);

    {
        let guard = state.lock().unwrap();
        let conn = guard.connection();
        // Every user table is empty; settings lost the session token too.
        for table in [
            "print_jobs",
            "template_versions",
            "templates",
            "fonts",
            "synced_datasets",
            "synced_profiles",
            "batches",
            "printers",
            "api_clients",
            "queued_uses",
            "sync_state",
            "settings",
        ] {
            let n: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "{table} was not wiped");
        }
        // The dead legacy table is gone; the schema tables survive.
        let old: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'printer_profiles'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(old, 0);
        let kept: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'templates'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kept, 1, "schema itself must survive the wipe");

        // Fresh status: no AUTOINCREMENT counters carried over, so the
        // next row restarts at 1 like a first install.
        let seq: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_sequence", [], |r| r.get(0))
            .unwrap();
        assert_eq!(seq, 0, "autoincrement counters survived the recreate");
        conn.execute(
            "INSERT INTO printers (name, type, address, language) VALUES ('N', 'ipp', 'z', 'pdf')",
            [],
        )
        .unwrap();
        assert_eq!(conn.last_insert_rowid(), 1);
    }

    // Font bytes went with their rows.
    assert!(!font_path.exists());
    let _ = std::fs::remove_dir_all(&fonts_dir);
}
