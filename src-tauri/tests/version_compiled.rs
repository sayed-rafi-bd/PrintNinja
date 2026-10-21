//! `set_version_compiled` writes the compiled stylesheet onto the existing
//! version row. Previews backfill old versions this way instead of minting
//! a new version per view.

use printninja_lib::commands::version::set_version_compiled_conn;
use printninja_lib::db::init;
use rusqlite::Connection;

fn test_db() -> (Connection, i64) {
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
    let vid = conn.last_insert_rowid();
    (conn, vid)
}

#[test]
fn backfill_updates_the_row_without_new_versions() {
    let (conn, vid) = test_db();
    let out = set_version_compiled_conn(&conn, vid, ".a{color:red}", "k1")
        .expect("backfill works");
    assert_eq!(out.compiled_css, ".a{color:red}");
    assert_eq!(out.compiled_key, "k1");
    // Same row, same version number — no new version minted.
    assert_eq!(out.id, vid);
    assert_eq!(out.version_no, 1);
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM template_versions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn backfill_rejects_unknown_versions() {
    let (conn, _) = test_db();
    let err = set_version_compiled_conn(&conn, 99999, "x", "y").unwrap_err();
    assert!(
        format!("{err:?}").contains("not found"),
        "unknown id must 404: {err:?}"
    );
}
