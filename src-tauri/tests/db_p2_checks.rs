//! P2 CHECK backfill: a database created before the constraints existed
//! upgrades in place — violating rows are sanitized to documented safe
//! values, tables are rebuilt with the CHECKs, and the migration is
//! idempotent (fresh installs skip the rebuilds entirely).
//!
//! The old shapes below mirror the pre-P2 schema plus applied
//! migrations, minus the new CHECKs.

use printninja_lib::db::init;
use rusqlite::Connection;

const OLD_SCHEMA: &str = "
CREATE TABLE printers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, type TEXT NOT NULL, address TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'pdf', paper_width_mm INTEGER,
    dpi INTEGER DEFAULT 203, default_settings_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    current_version_id INTEGER,
    page_w_mm INTEGER NOT NULL DEFAULT 210, page_h_mm INTEGER NOT NULL DEFAULT 297,
    orientation TEXT NOT NULL DEFAULT 'portrait',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    readme TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
    remote_id TEXT, published_at TEXT,
    origin TEXT NOT NULL DEFAULT 'own', origin_owner TEXT,
    withdrawn INTEGER NOT NULL DEFAULT 0, server_id TEXT,
    server_revision INTEGER, base_revision INTEGER,
    sync_state TEXT NOT NULL DEFAULT 'synced', kind TEXT NOT NULL DEFAULT 'own',
    owner_handle TEXT, synced_at TEXT
);
CREATE TABLE template_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL, version_no INTEGER NOT NULL,
    html TEXT NOT NULL, css TEXT NOT NULL DEFAULT '', label TEXT, note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT NOT NULL DEFAULT 'manual',
    compiled_css TEXT NOT NULL DEFAULT '', compiled_key TEXT NOT NULL DEFAULT ''
);
CREATE TABLE fonts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, family TEXT NOT NULL,
    style TEXT NOT NULL DEFAULT 'normal', weight TEXT NOT NULL DEFAULT '400',
    file_path TEXT NOT NULL, format TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    server_id TEXT, server_revision INTEGER, base_revision INTEGER,
    sync_state TEXT NOT NULL DEFAULT 'synced', synced_at TEXT,
    sha256 TEXT NOT NULL DEFAULT '', size_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT, template_id INTEGER, printer_id INTEGER,
    total INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'single_job', status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE print_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER, record_index INTEGER,
    template_id INTEGER, template_version_id INTEGER, printer_id INTEGER,
    source TEXT NOT NULL DEFAULT 'ui', source_url TEXT,
    status TEXT NOT NULL DEFAULT 'queued', error TEXT,
    copies INTEGER NOT NULL DEFAULT 1, settings_json TEXT, rendered_html TEXT,
    data_json TEXT, idempotency_key TEXT, is_test INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT, finished_at TEXT, duration_ms INTEGER, timings_json TEXT
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL,
    sync_state TEXT NOT NULL DEFAULT 'synced', synced_at TEXT);
CREATE TABLE api_clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    key_hash TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT 'print',
    allowed_ips TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
);";

fn old_db() -> Connection {
    let conn = Connection::open_in_memory().expect("memory db");
    conn.execute_batch(OLD_SCHEMA).expect("old schema");
    conn
}

#[test]
fn p2_checks_sanitize_then_rebuild() {
    let conn = old_db();
    conn.execute(
        "INSERT INTO printers (name, type, address, language, dpi, paper_width_mm)
         VALUES ('', 'ipp', '', 'pdf', -1, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm) VALUES ('', -80, 0)",
        [],
    )
    .unwrap();
    let tid: i64 = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO fonts (family, file_path, format, size_bytes)
         VALUES ('', 'f.ttf', 'exe', -5)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO batches (total, done, failed) VALUES (2, 5, 9)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO print_jobs (copies, is_test, duration_ms, record_index)
         VALUES (0, 7, -3, -1)",
        [],
    )
    .unwrap();
    conn.execute("INSERT INTO settings (key, value) VALUES ('', 'x')", [])
        .unwrap();
    conn.execute(
        "INSERT INTO api_clients (name, key_hash) VALUES ('Dead', '')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO api_clients (name, key_hash) VALUES ('', 'h1')",
        [],
    )
    .unwrap();

    init(&conn).expect("upgrade with sanitize + rebuild works");

    // Sanitized to the documented safe values.
    let (name, address, dpi, paper): (String, String, i64, Option<i64>) = conn
        .query_row(
            "SELECT name, address, dpi, paper_width_mm FROM printers",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        (name.as_str(), address.as_str(), dpi, paper),
        ("(unnamed)", "(unknown)", 203, None)
    );
    let (tname, w, h): (String, i64, i64) = conn
        .query_row(
            "SELECT name, page_w_mm, page_h_mm FROM templates",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!((tname.as_str(), w, h), ("(unnamed)", 210, 297));
    let versions_table: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='template_versions'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(versions_table, 0, "versions table is removed");
    let html: String = conn
        .query_row("SELECT html FROM templates WHERE id = ?1", [tid], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(html, "");
    let (family, format, size): (String, String, i64) = conn
        .query_row("SELECT family, format, size_bytes FROM fonts", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    assert_eq!(
        (family.as_str(), format.as_str(), size),
        ("(unnamed)", "ttf", 0)
    );
    let (total, done, failed): (i64, i64, i64) = conn
        .query_row("SELECT total, done, failed FROM batches", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    assert_eq!((total, done, failed), (2, 2, 2));
    let (copies, is_test, duration, record): (i64, i64, Option<i64>, Option<i64>) = conn
        .query_row(
            "SELECT copies, is_test, duration_ms, record_index FROM print_jobs",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!((copies, is_test, duration, record), (1, 0, None, None));
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM settings", [], |r: &rusqlite::Row| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0,
        "empty setting keys are dropped"
    );
    let names: Vec<String> = conn
        .prepare("SELECT name FROM api_clients ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        names,
        vec!["(unnamed 2)"],
        "empty-hash clients are dropped; empty names stay unique"
    );

    // And the CHECKs are live now.
    assert!(conn
        .execute(
            "INSERT INTO printers (name, type, address, language) VALUES ('', 'ipp', 'x', 'pdf')",
            []
        )
        .is_err());
    assert!(conn
        .execute("INSERT INTO print_jobs (copies) VALUES (0)", [])
        .is_err());
    assert!(conn
        .execute(
            "INSERT INTO fonts (family, file_path, format) VALUES ('F', 'f.ttf', 'exe')",
            []
        )
        .is_err());

    // Idempotent: a second init changes nothing.
    init(&conn).expect("re-init works");
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM printers", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
}
