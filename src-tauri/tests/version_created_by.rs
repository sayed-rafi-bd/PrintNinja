//! Regression tests for version author `sync` (Phase 0, P2).
//!
//! "Refresh from server" creates a version with `created_by: "sync"`. Rust
//! accepts that value, but the `template_versions` CHECK constraint allowed
//! only `manual`, `autosave` and `restore`, so the insert failed. SQLite
//! cannot ALTER a CHECK, so the migration rebuilds the table — keeping every
//! existing row.

use printninja_lib::commands::version::{create_version_conn, CreateVersionRequest};
use printninja_lib::db::{ensure_v2_schema, init};
use printninja_lib::AppError;
use rusqlite::Connection;

fn test_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    init(&conn).expect("apply schema");
    conn.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation)
         VALUES ('Invoice', 80, 200, 'portrait')",
        [],
    )
    .unwrap();
    let tid = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO template_versions (template_id, version_no, html, css, created_by)
         VALUES (?1, 1, '<p>v1</p>', '', 'manual')",
        [tid],
    )
    .unwrap();
    conn.execute(
        "UPDATE templates SET current_version_id = (SELECT id FROM template_versions
             WHERE template_id = ?1) WHERE id = ?1",
        [tid],
    )
    .unwrap();
    conn
}

fn template_id(conn: &Connection) -> i64 {
    conn.query_row("SELECT id FROM templates LIMIT 1", [], |r| r.get(0))
        .unwrap()
}

fn request(conn: &Connection, created_by: &str) -> CreateVersionRequest {
    CreateVersionRequest {
        template_id: template_id(conn),
        html: "<p>refreshed</p>".into(),
        css: "".into(),
        label: None,
        note: None,
        created_by: Some(created_by.into()),
        compiled_css: None,
        compiled_key: None,
    }
}

#[test]
fn sync_author_is_accepted_by_create_version() {
    let conn = test_db();

    let version = create_version_conn(&conn, request(&conn, "sync"))
        .expect("a Refresh from server (created_by: sync) must save");

    assert_eq!(version.created_by, "sync");
    assert_eq!(version.version_no, 2);
    assert_eq!(version.html, "<p>refreshed</p>");
}

#[test]
fn unknown_author_is_rejected_before_the_insert() {
    let conn = test_db();

    let err = create_version_conn(&conn, request(&conn, "backspace")).unwrap_err();
    assert!(
        matches!(err, AppError::Validation(_)),
        "expected Validation, got {err:?}"
    );
}

/// The three v1 authors still work, so the rebuild (or the fresh schema)
/// changed nothing for existing rows and code paths.
#[test]
fn v1_authors_still_work() {
    let conn = test_db();
    for author in ["manual", "autosave", "restore"] {
        create_version_conn(&conn, request(&conn, author))
            .unwrap_or_else(|e| panic!("{author} must still be accepted: {e}"));
    }
}

/// A database created by the original v1 schema — CHECK without 'sync', no
/// compiled_* columns — must come out of `ensure_v2_schema` with its rows
/// intact, the compiled columns added, and 'sync' accepted.
#[test]
fn old_database_is_rebuilt_and_keeps_every_row() {
    let conn = Connection::open_in_memory().unwrap();
    // The v1-era DDL, verbatim: no compiled_* columns, and a CHECK that
    // rejects 'sync'. Stated here (not read from schema.sql) because
    // schema.sql now carries the current definition.
    conn.execute_batch(
        "CREATE TABLE templates (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             name TEXT NOT NULL,
             current_version_id INTEGER,
             page_w_mm INTEGER NOT NULL DEFAULT 210,
             page_h_mm INTEGER NOT NULL DEFAULT 297,
             orientation TEXT NOT NULL DEFAULT 'portrait'
                 CHECK(orientation IN ('portrait', 'landscape')),
             created_at TEXT NOT NULL DEFAULT (datetime('now')),
             updated_at TEXT NOT NULL DEFAULT (datetime('now'))
         );
         CREATE TABLE template_versions (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
             version_no INTEGER NOT NULL,
             html TEXT NOT NULL,
             css TEXT NOT NULL DEFAULT '',
             label TEXT,
             note TEXT,
             created_at TEXT NOT NULL DEFAULT (datetime('now')),
             created_by TEXT NOT NULL DEFAULT 'manual'
                 CHECK(created_by IN ('manual', 'autosave', 'restore'))
         );
         CREATE INDEX idx_versions_template ON template_versions(template_id);
         CREATE TABLE api_clients (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             name TEXT NOT NULL,
             key_hash TEXT NOT NULL,
             scopes TEXT NOT NULL DEFAULT 'print',
             allowed_ips TEXT,
             created_at TEXT NOT NULL DEFAULT (datetime('now')),
             last_used_at TEXT
         );
         INSERT INTO templates (name) VALUES ('Old');
         INSERT INTO template_versions (template_id, version_no, html, css, created_by)
         VALUES (1, 1, '<p>first</p>', '.a{}', 'manual'),
               (1, 2, '<p>second</p>', '.b{}', 'restore');",
    )
    .unwrap();

    ensure_v2_schema(&conn).expect("migration must run");

    // Every row survived with its content.
    let (count, html): (i64, String) = conn
        .query_row(
            "SELECT COUNT(*), MIN(html) FROM template_versions",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(count, 2, "the rebuild must keep every row");
    assert_eq!(html, "<p>first</p>");

    // The compiled_* columns exist (the v2 ALTERs ran before the rebuild) …
    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(template_versions)")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(cols.contains(&"compiled_css".to_string()), "{cols:?}");
    assert!(cols.contains(&"compiled_key".to_string()), "{cols:?}");

    // … and 'sync' is accepted, while an unknown author is still refused.
    conn.execute(
        "INSERT INTO template_versions (template_id, version_no, html, css, created_by)
         VALUES (1, 3, '<p>third</p>', '', 'sync')",
        [],
    )
    .expect("the rebuilt CHECK must allow 'sync'");
    let rejected = conn.execute(
        "INSERT INTO template_versions (template_id, version_no, html, css, created_by)
         VALUES (1, 4, '', '', 'backspace')",
        [],
    );
    assert!(rejected.is_err(), "an unknown author must still fail");

    // Idempotent: a second migration changes nothing.
    ensure_v2_schema(&conn).expect("second run must not fail");
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM template_versions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 3);
}
