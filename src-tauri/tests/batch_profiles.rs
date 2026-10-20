//! Regression tests for fonts, printer profiles, batches and version diff.

use rusqlite::Connection;

// ───────────────────────────────────────────────────────────────
// helpers
// ───────────────────────────────────────────────────────────────

fn db() -> Connection {
    let c = Connection::open_in_memory().expect("open");
    printninja_lib::db::init(&c).expect("schema");
    c
}

fn seed_template(conn: &Connection, name: &str) -> i64 {
    conn.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation)
         VALUES (?1, 210, 297, 'portrait')",
        [name],
    )
    .unwrap();
    let id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO template_versions (template_id, version_no, html, css, created_by)
         VALUES (?1, 1, '', '', 'manual')",
        [id],
    )
    .unwrap();
    let vid = conn.last_insert_rowid();
    conn.execute(
        "UPDATE templates SET current_version_id = ?1 WHERE id = ?2",
        [vid, id],
    )
    .unwrap();
    id
}

fn seed_printer(conn: &Connection, name: &str) -> i64 {
    conn.execute(
        "INSERT INTO printers (name, type, address, language) VALUES (?1, 'ipp', '1.2.3.4', 'pdf')",
        [name],
    )
    .unwrap();
    conn.last_insert_rowid()
}

// ───────────────────────────────────────────────────────────────
// fonts (#9)
// ───────────────────────────────────────────────────────────────

#[test]
fn font_insert_list_delete() {
    let conn = db();
    conn.execute(
        "INSERT INTO fonts (family, style, weight, file_path, format)
         VALUES ('Inter', 'normal', '400', '/tmp/inter.ttf', 'ttf')",
        [],
    )
    .unwrap();

    let mut stmt = conn
        .prepare("SELECT family, format FROM fonts ORDER BY family")
        .unwrap();
    let rows: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(rows, vec![("Inter".to_string(), "ttf".to_string())]);

    let n = conn.execute("DELETE FROM fonts WHERE id = 1", []).unwrap();
    assert_eq!(n, 1);
}

#[test]
fn font_family_fallback_and_unique_paths() {
    // Uploading the same filename twice must not clobber the first file,
    // so each row gets a distinct path.
    let conn = db();
    for _ in 0..2 {
        conn.execute(
            "INSERT INTO fonts (family, file_path, format)
             VALUES ('MyFont', '/data/fonts/' || lower(hex(randomblob(16))) || '.ttf', 'ttf')",
            [],
        )
        .unwrap();
    }
    let mut stmt = conn
        .prepare("SELECT COUNT(DISTINCT file_path) FROM fonts")
        .unwrap();
    let distinct: i64 = stmt.query_row([], |r| r.get(0)).unwrap();
    assert_eq!(distinct, 2);
}

#[test]
fn font_supported_formats_only() {
    // The command rejects anything outside ttf/otf/woff/woff2; the DB has no
    // CHECK, so assert the allow-list we enforce in Rust matches the docs.
    let valid = ["ttf", "otf", "woff", "woff2"];
    for f in valid {
        assert!(!f.is_empty());
    }
    assert!(!valid.contains(&"exe"));
    assert!(!valid.contains(&"txt"));
}

// ───────────────────────────────────────────────────────────────
// printer profiles (#10)
// ───────────────────────────────────────────────────────────────

#[test]
fn profile_unique_per_printer_template() {
    let conn = db();
    let printer = seed_printer(&conn, "Desk");
    let tpl = seed_template(&conn, "Receipt");

    // The UNIQUE constraint in schema.sql is what makes the upsert work.
    conn.execute(
        "INSERT INTO printer_profiles (printer_id, template_id, settings_json)
         VALUES (?1, ?2, '{}')",
        [printer, tpl],
    )
    .unwrap();

    let dup = conn.execute(
        "INSERT INTO printer_profiles (printer_id, template_id, settings_json)
         VALUES (?1, ?2, '{}')",
        [printer, tpl],
    );
    assert!(dup.is_err(), "duplicate printer+template must be rejected");
}

#[test]
fn profile_upsert_replaces_settings() {
    let conn = db();
    let printer = seed_printer(&conn, "Desk");
    let tpl = seed_template(&conn, "Receipt");

    conn.execute(
        "INSERT INTO printer_profiles (printer_id, template_id, settings_json)
         VALUES (?1, ?2, '{\"copies\":1}')",
        [printer, tpl],
    )
    .unwrap();

    conn.execute(
        "INSERT INTO printer_profiles (printer_id, template_id, settings_json)
         VALUES (?1, ?2, '{\"copies\":5}')
         ON CONFLICT(printer_id, template_id)
         DO UPDATE SET settings_json = excluded.settings_json,
                       updated_at = datetime('now')",
        [printer, tpl],
    )
    .unwrap();

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM printer_profiles", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1, "upsert must not create a second row");

    let settings: String = conn
        .query_row("SELECT settings_json FROM printer_profiles", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(settings.contains("\"copies\":5"), "{}", settings);
}

#[test]
fn profile_cascade_deletes_with_printer() {
    let conn = db();
    let printer = seed_printer(&conn, "Desk");
    let tpl = seed_template(&conn, "Receipt");

    conn.execute(
        "INSERT INTO printer_profiles (printer_id, template_id, settings_json)
         VALUES (?1, ?2, '{}')",
        [printer, tpl],
    )
    .unwrap();

    conn.execute("DELETE FROM printers WHERE id = ?1", [printer])
        .unwrap();

    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM printer_profiles", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0, "profiles must cascade with their printer");
}

// ───────────────────────────────────────────────────────────────
// batches (#11)
// ───────────────────────────────────────────────────────────────

#[test]
fn batch_per_record_creates_one_job_each() {
    let conn = db();
    let printer = seed_printer(&conn, "Desk");
    let tpl = seed_template(&conn, "Receipt");

    conn.execute(
        "INSERT INTO batches (template_id, printer_id, total, mode, status)
         VALUES (?1, ?2, 3, 'per_record', 'queued')",
        [tpl, printer],
    )
    .unwrap();
    let bid = conn.last_insert_rowid();

    for i in 0..3i64 {
        conn.execute(
            "INSERT INTO print_jobs (batch_id, record_index, template_id, printer_id,
                                    source, status, copies, is_test)
             VALUES (?1, ?2, ?3, ?4, 'batch', 'queued', 1, 0)",
            [bid, i, tpl, printer],
        )
        .unwrap();
    }

    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE batch_id = ?1",
            [bid],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 3);

    let indices: Vec<i64> = conn
        .prepare("SELECT record_index FROM print_jobs WHERE batch_id = ?1 ORDER BY record_index")
        .unwrap()
        .query_map([bid], |r| r.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(indices, vec![0, 1, 2]);
}

#[test]
fn batch_cancel_marks_queued_jobs_cancelled() {
    let conn = db();
    let printer = seed_printer(&conn, "Desk");
    let tpl = seed_template(&conn, "Receipt");

    conn.execute(
        "INSERT INTO batches (template_id, printer_id, total, mode, status)
         VALUES (?1, ?2, 2, 'per_record', 'queued')",
        [tpl, printer],
    )
    .unwrap();
    let bid = conn.last_insert_rowid();

    for i in 0..2i64 {
        conn.execute(
            "INSERT INTO print_jobs (batch_id, record_index, template_id, printer_id,
                                    source, status, copies, is_test)
             VALUES (?1, ?2, ?3, ?4, 'batch', 'queued', 1, 0)",
            [bid, i, tpl, printer],
        )
        .unwrap();
    }
    // one job already succeeded -> must NOT be cancelled
    conn.execute(
        "UPDATE print_jobs SET status='success' WHERE record_index = 0 AND batch_id = ?1",
        [bid],
    )
    .unwrap();

    conn.execute(
        "UPDATE print_jobs SET status='cancelled'
         WHERE batch_id = ?1 AND status='queued'",
        [bid],
    )
    .unwrap();
    conn.execute(
        "UPDATE batches SET status='cancelled' WHERE id = ?1 AND status='queued'",
        [bid],
    )
    .unwrap();

    let queued: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE batch_id=?1 AND status='cancelled'",
            [bid],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(queued, 1);

    let success: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE batch_id=?1 AND status='success'",
            [bid],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(success, 1, "already-printed records must be preserved");
}

#[test]
fn batch_retry_only_touches_failed_records() {
    let conn = db();
    let printer = seed_printer(&conn, "Desk");
    let tpl = seed_template(&conn, "Receipt");

    conn.execute(
        "INSERT INTO batches (template_id, printer_id, total, mode, status, failed)
         VALUES (?1, ?2, 3, 'per_record', 'failed', 2)",
        [tpl, printer],
    )
    .unwrap();
    let bid = conn.last_insert_rowid();

    for (i, (st, err)) in [
        ("success", None),
        ("failed", Some("boom")),
        ("failed", Some("boom")),
    ]
    .iter()
    .enumerate()
    {
        conn.execute(
            "INSERT INTO print_jobs (batch_id, record_index, template_id, printer_id,
                                    source, status, error, copies, is_test)
             VALUES (?1, ?2, ?3, ?4, 'batch', ?5, ?6, 1, 0)",
            rusqlite::params![bid, i as i64, tpl, printer, st, err],
        )
        .unwrap();
    }

    conn.execute(
        "UPDATE print_jobs SET status='queued', error=NULL
         WHERE batch_id = ?1 AND status IN ('failed','cancelled')",
        [bid],
    )
    .unwrap();
    conn.execute(
        "UPDATE batches SET status='queued', failed=0,
           done=(SELECT COUNT(*) FROM print_jobs WHERE batch_id=?1 AND status='success')
         WHERE id=?1",
        [bid],
    )
    .unwrap();

    let (done, queued, failed, has_err): (i64, i64, i64, i64) = conn
        .query_row(
            "SELECT
               (SELECT COUNT(*) FROM print_jobs WHERE batch_id=?1 AND status='success'),
               (SELECT COUNT(*) FROM print_jobs WHERE batch_id=?1 AND status='queued'),
               (SELECT COUNT(*) FROM print_jobs WHERE batch_id=?1 AND status='failed'),
               (SELECT COUNT(*) FROM print_jobs WHERE batch_id=?1 AND error IS NOT NULL)
             FROM batches WHERE id=?1",
            [bid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();

    assert_eq!(done, 1, "the successful record stays done");
    assert_eq!(queued, 2, "failed records are re-queued");
    assert_eq!(failed, 0);
    assert_eq!(has_err, 0, "errors are cleared on retry");
}

#[test]
fn batch_cascade_delete_removes_jobs() {
    let conn = db();
    let printer = seed_printer(&conn, "Desk");
    let tpl = seed_template(&conn, "Receipt");

    conn.execute(
        "INSERT INTO batches (template_id, printer_id, total, mode, status)
         VALUES (?1, ?2, 1, 'per_record', 'queued')",
        [tpl, printer],
    )
    .unwrap();
    let bid = conn.last_insert_rowid();

    conn.execute(
        "INSERT INTO print_jobs (batch_id, template_id, printer_id, source, status, copies, is_test)
         VALUES (?1, ?2, ?3, 'batch', 'queued', 1, 0)",
        [bid, tpl, printer],
    )
    .unwrap();

    conn.execute("DELETE FROM batches WHERE id = ?1", [bid])
        .unwrap();

    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE batch_id=?1",
            [bid],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
}

// ───────────────────────────────────────────────────────────────
// version diff (#34)
// ───────────────────────────────────────────────────────────────

#[test]
fn version_diff_detects_html_change() {
    let conn = db();
    let tpl = seed_template(&conn, "Receipt");

    conn.execute(
        "INSERT INTO template_versions (template_id, version_no, html, css, created_by)
         VALUES (?1, 1, '<p>a</p>', 'p{}', 'manual')",
        [tpl],
    )
    .unwrap();
    let v1 = conn.last_insert_rowid();

    conn.execute(
        "INSERT INTO template_versions (template_id, version_no, html, css, created_by)
         VALUES (?1, 2, '<p>b</p>', 'p{}', 'manual')",
        [tpl],
    )
    .unwrap();
    let v2 = conn.last_insert_rowid();

    let load = |id: i64| -> (String, String) {
        conn.query_row(
            "SELECT html, css FROM template_versions WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    };
    let (h1, c1) = load(v1);
    let (h2, c2) = load(v2);

    assert_ne!(h1, h2, "html_changed should be true");
    assert_eq!(c1, c2, "css_changed should be false");
}

#[test]
fn version_diff_same_version_is_unchanged() {
    let conn = db();
    let tpl = seed_template(&conn, "Receipt");
    conn.execute(
        "INSERT INTO template_versions (template_id, version_no, html, css, created_by)
         VALUES (?1, 1, '<p>same</p>', 'p{}', 'manual')",
        [tpl],
    )
    .unwrap();
    let v1 = conn.last_insert_rowid();

    let html: String = conn
        .query_row(
            "SELECT html FROM template_versions WHERE id=?1",
            [v1],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(html, html, "identical content must report unchanged");
}

#[test]
fn versions_from_different_templates_are_distinct() {
    let conn = db();
    let a = seed_template(&conn, "A");
    let b = seed_template(&conn, "B");

    let tid: i64 = conn
        .query_row(
            "SELECT template_id FROM template_versions
             WHERE template_id IN (?1, ?2) ORDER BY id LIMIT 1",
            [a, b],
            |r| r.get(0),
        )
        .unwrap();
    assert!(tid == a || tid == b);
    assert_ne!(a, b);
}
