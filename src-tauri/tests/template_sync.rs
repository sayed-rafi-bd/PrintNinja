//! Integration tests for the local template commands used by sync: Save writes
//! the server link, Refresh rewrites the content and the metadata.
//!
//! They run against a real SQLite connection, so the SQL is actually executed.

use printninja_lib::commands::template::{
    write_publish_info, write_template_meta, SetPublishInfoRequest, UpdateTemplateMetaRequest,
};
use printninja_lib::AppError;
use rusqlite::Connection;

fn seeded_db() -> Connection {
    let mut conn = Connection::open_in_memory().expect("open in-memory db");
    conn.execute_batch(include_str!("../src/db/schema.sql"))
        .expect("apply schema");
    printninja_lib::db::ensure_v2_schema(&mut conn).expect("apply v2 schema");
    conn.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation, readme, summary)
         VALUES ('Invoice', 80, 200, 'portrait', '# Invoice', 'A4 invoice')",
        [],
    )
    .unwrap();
    conn
}

fn meta(name: &str, w: i64, h: i64, summary: &str) -> UpdateTemplateMetaRequest {
    UpdateTemplateMetaRequest {
        id: 1,
        name: name.into(),
        page_w_mm: w,
        page_h_mm: h,
        summary: Some(summary.into()),
    }
}

fn columns(conn: &Connection) -> (String, i64, i64, String, String, bool) {
    let mut stmt = conn
        .prepare(
            "SELECT name, page_w_mm, page_h_mm, orientation, summary,
                    published_at IS NOT NULL AND published_at != ''
             FROM templates WHERE id = 1",
        )
        .unwrap();
    stmt.query_row([], |r| {
        Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get::<_, i64>(5)? != 0,
        ))
    })
    .unwrap()
}

// ── update_template_meta ─────────────────────────────────────────────────────

#[test]
fn update_template_meta_writes_name_page_size_and_summary() {
    let conn = seeded_db();
    let updated = write_template_meta(&conn, &meta("Invoice A4", 210, 297, "A4")).unwrap();

    assert_eq!(updated.name, "Invoice A4");
    assert_eq!(updated.page_w_mm, 210);
    assert_eq!(updated.page_h_mm, 297);
    assert_eq!(updated.summary, "A4");
    let (name, w, h, orientation, summary, _) = columns(&conn);
    assert_eq!(
        (name.as_str(), w, h, summary.as_str()),
        ("Invoice A4", 210, 297, "A4")
    );
    assert_eq!(orientation, "portrait");
}

#[test]
fn update_template_meta_derives_landscape_from_the_page() {
    let conn = seeded_db();
    write_template_meta(&conn, &meta("Wide", 297, 210, "")).unwrap();
    let (_, _, _, orientation, _, _) = columns(&conn);
    assert_eq!(orientation, "landscape");
}

#[test]
fn update_template_meta_trims_the_name_and_leaves_content_alone() {
    let conn = seeded_db();
    conn.execute(
        "INSERT INTO template_versions (template_id, version_no, html, css, created_by)
         VALUES (1, 1, '<p>local</p>', '.local {}', 'manual')",
        [],
    )
    .unwrap();
    let version_id = conn.last_insert_rowid();
    conn.execute(
        "UPDATE templates SET current_version_id = ?1 WHERE id = 1",
        [version_id],
    )
    .unwrap();

    write_template_meta(&conn, &meta("  Padded  ", 80, 200, "")).unwrap();

    let (html, css, readme): (String, String, String) = conn
        .query_row(
            "SELECT v.html, v.css, t.readme FROM template_versions v
             JOIN templates t ON t.current_version_id = v.id WHERE t.id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        (html.as_str(), css.as_str(), readme.as_str()),
        ("<p>local</p>", ".local {}", "# Invoice")
    );
}

#[test]
fn update_template_meta_rejects_a_blank_name_and_a_bad_page() {
    let conn = seeded_db();
    assert!(write_template_meta(&conn, &meta("   ", 80, 200, "")).is_err());
    assert!(write_template_meta(&conn, &meta("Fine", 0, 200, "")).is_err());
    assert!(write_template_meta(&conn, &meta("Fine", 80, -1, "")).is_err());

    let (name, _, _, _, _, _) = columns(&conn);
    assert_eq!(name, "Invoice", "a rejected write must not change the row");
}

#[test]
fn update_template_meta_reports_a_missing_template() {
    let conn = seeded_db();
    let err = write_template_meta(
        &conn,
        &UpdateTemplateMetaRequest {
            id: 999,
            ..meta("Nope", 80, 200, "")
        },
    )
    .unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "{err:?}");
}

// ── set_publish_info ────────────────────────────────────────────────────────

const REMOTE_ID: &str = "11111111-1111-4111-8111-111111111111";

#[test]
fn a_null_publish_time_links_the_template_without_publishing_it() {
    let conn = seeded_db();
    let t = write_publish_info(
        &conn,
        &SetPublishInfoRequest {
            id: 1,
            remote_id: REMOTE_ID.into(),
            published_at: None,
        },
    )
    .unwrap();

    assert_eq!(t.remote_id.as_deref(), Some(REMOTE_ID));
    assert_eq!(
        t.published_at, None,
        "a first Save keeps the template private"
    );
    let (_, _, _, _, _, published) = columns(&conn);
    assert!(!published);

    let updated_at: String = conn
        .query_row("SELECT updated_at FROM templates WHERE id = 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(
        updated_at.len() >= 10,
        "a linked-but-private row is touched, not left without a timestamp: {updated_at:?}"
    );
}

#[test]
fn a_publish_time_marks_the_row_as_in_step_with_the_server() {
    let conn = seeded_db();
    write_publish_info(
        &conn,
        &SetPublishInfoRequest {
            id: 1,
            remote_id: REMOTE_ID.into(),
            published_at: None,
        },
    )
    .unwrap();
    let t = write_publish_info(
        &conn,
        &SetPublishInfoRequest {
            id: 1,
            remote_id: REMOTE_ID.into(),
            published_at: Some("2026-03-01T00:00:00Z".into()),
        },
    )
    .unwrap();

    assert_eq!(t.published_at.as_deref(), Some("2026-03-01T00:00:00Z"));
    assert_eq!(t.updated_at, "2026-03-01T00:00:00Z");
    let (_, _, _, _, _, published) = columns(&conn);
    assert!(published);
}

#[test]
fn set_publish_info_rejects_an_id_that_is_not_a_uuid() {
    let conn = seeded_db();
    let err = write_publish_info(
        &conn,
        &SetPublishInfoRequest {
            id: 1,
            remote_id: "not-a-uuid".into(),
            published_at: None,
        },
    )
    .unwrap_err();
    assert!(matches!(err, AppError::Validation(_)), "{err:?}");
}
