//! `list_latest_versions` returns the current version per template in one
//! query, so Designer hydration is a single round trip instead of N+1.

use printninja_lib::commands::version::{
    create_version_conn, list_latest_versions_conn, CreateVersionRequest,
};
use printninja_lib::db::init;
use rusqlite::Connection;

fn test_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    init(&conn).expect("apply schema");
    conn.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation)
         VALUES ('A', 80, 200, 'portrait'), ('B', 80, 200, 'portrait')",
        [],
    )
    .unwrap();
    conn
}

fn add_version(conn: &Connection, template_id: i64, html: &str) {
    create_version_conn(
        conn,
        CreateVersionRequest {
            template_id,
            html: html.into(),
            css: "".into(),
            label: None,
            note: None,
            created_by: Some("manual".into()),
            compiled_css: None,
            compiled_key: None,
        },
    )
    .expect("seed version");
}

#[test]
fn returns_only_the_latest_per_template() {
    let conn = test_db();
    add_version(&conn, 1, "<p>a1</p>");
    add_version(&conn, 1, "<p>a2</p>");
    add_version(&conn, 2, "<p>b1</p>");

    let latest = list_latest_versions_conn(&conn, &[1, 2, 999]).expect("batch works");
    assert_eq!(latest.len(), 2, "unknown ids are skipped, not errors");
    let a = latest.iter().find(|v| v.template_id == 1).unwrap();
    assert_eq!(a.html, "<p>a2</p>");
    assert_eq!(a.version_no, 2);
    let b = latest.iter().find(|v| v.template_id == 2).unwrap();
    assert_eq!(b.html, "<p>b1</p>");
}

#[test]
fn empty_input_returns_empty_without_querying() {
    let conn = test_db();
    assert!(list_latest_versions_conn(&conn, &[]).unwrap().is_empty());
}
