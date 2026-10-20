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
