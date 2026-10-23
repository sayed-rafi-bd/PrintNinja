//! Regression tests for the history job commands (Phase 0, P1).
//!
//! `SELECT_JOB_COLUMNS` used to end in `ORDER BY id DESC`, and `get_job`,
//! `reprint_job` and `retry_job` appended `WHERE id = ?1` after it — a SQL
//! syntax error. No test called those commands, which is how it survived.
//! These tests go through the `*_conn` bodies the IPC commands wrap.

use printninja_lib::commands::history::{
    delete_job_conn, get_job_conn, list_jobs_conn, reprint_job_conn, retry_job_conn,
};
use printninja_lib::db::Database;
use printninja_lib::AppError;
use std::sync::{Arc, Mutex};

/// A file-backed Database (the same open path the app uses) seeded with one
/// printer, one template version, and one finished job.
fn test_db() -> Arc<Mutex<Database>> {
    let path = std::env::temp_dir().join(format!("printninja_history_{}.db", uuid::Uuid::new_v4()));
    let db = Database::open(&format!("sqlite:{}", path.display())).expect("open db");
    let db = Arc::new(Mutex::new(db));

    let guard = db.lock().unwrap();
    let conn = guard.connection();
    conn.execute(
        "INSERT INTO printers (name, type, address, language)
         VALUES ('Desk', 'ipp', '127.0.0.1', 'pdf')",
        [],
    )
    .unwrap();
    let printer_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO templates (name, html) VALUES ('Label', '<p>v1</p>')",
        [],
    )
    .unwrap();
    let template_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO print_jobs
           (template_id, printer_id, source, status, copies, is_test)
         VALUES (?1, ?2, 'ui', 'success', 2, 0)",
        rusqlite::params![template_id, printer_id],
    )
    .unwrap();

    drop(guard);
    db
}

#[test]
fn get_job_returns_the_row() {
    let db = test_db();
    let guard = db.lock().unwrap();
    let conn = guard.connection();

    let seed_id: i64 = conn
        .query_row("SELECT id FROM print_jobs LIMIT 1", [], |r| r.get(0))
        .unwrap();

    let job = get_job_conn(conn, seed_id).expect("get_job must find the row");
    assert_eq!(job.id, seed_id);
    assert_eq!(job.status, "success");
    assert_eq!(job.copies, 2);
    assert_eq!(job.source, "ui");
}

#[test]
fn get_job_unknown_id_is_not_found() {
    let db = test_db();
    let guard = db.lock().unwrap();

    let err = get_job_conn(guard.connection(), 999_999).unwrap_err();
    assert!(
        matches!(err, AppError::NotFound(_)),
        "expected NotFound, got {err:?}"
    );
}

#[test]
fn reprint_job_clones_the_original_and_returns_the_new_row() {
    let db = test_db();
    let guard = db.lock().unwrap();
    let conn = guard.connection();

    let seed_id: i64 = conn
        .query_row("SELECT id FROM print_jobs LIMIT 1", [], |r| r.get(0))
        .unwrap();

    let before: i64 = conn
        .query_row("SELECT COUNT(*) FROM print_jobs", [], |r| r.get(0))
        .unwrap();

    let new_job = reprint_job_conn(conn, seed_id).expect("reprint must work");
    assert_ne!(new_job.id, seed_id, "reprint creates a new row");
    assert_eq!(new_job.status, "queued", "a reprinted job starts queued");
    assert_eq!(
        new_job.template_id,
        Some(
            conn.query_row(
                "SELECT template_id FROM print_jobs WHERE id = ?1",
                [seed_id],
                |r| r.get(0)
            )
            .unwrap()
        )
    );
    assert_eq!(new_job.copies, 2, "copies are reproduced from the original");
    assert!(!new_job.is_test);

    let after: i64 = conn
        .query_row("SELECT COUNT(*) FROM print_jobs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(after, before + 1);
}

#[test]
fn retry_job_resets_the_row_and_returns_it() {
    let db = test_db();
    let guard = db.lock().unwrap();
    let conn = guard.connection();

    // Make the seed job look failed-with-timestamps, then retry it.
    let seed_id: i64 = conn
        .query_row("SELECT id FROM print_jobs LIMIT 1", [], |r| r.get(0))
        .unwrap();
    conn.execute(
        "UPDATE print_jobs SET status = 'failed', error = 'offline',
             started_at = '2026-01-01', finished_at = '2026-01-01', duration_ms = 5
         WHERE id = ?1",
        [seed_id],
    )
    .unwrap();

    let job = retry_job_conn(conn, seed_id).expect("retry must work");
    assert_eq!(job.id, seed_id);
    assert_eq!(job.status, "queued");
    assert!(job.error.is_none());
    assert!(job.started_at.is_none());
    assert!(job.finished_at.is_none());
    assert!(job.duration_ms.is_none());
}

#[test]
fn retry_unknown_job_is_not_found() {
    let db = test_db();
    let guard = db.lock().unwrap();

    let err = retry_job_conn(guard.connection(), 42).unwrap_err();
    assert!(
        matches!(err, AppError::NotFound(_)),
        "expected NotFound, got {err:?}"
    );
}

#[test]
fn list_jobs_returns_newest_first() {
    let db = test_db();
    let guard = db.lock().unwrap();
    let conn = guard.connection();

    let seed_id: i64 = conn
        .query_row("SELECT id FROM print_jobs LIMIT 1", [], |r| r.get(0))
        .unwrap();
    reprint_job_conn(conn, seed_id).expect("second row");

    let jobs = list_jobs_conn(conn).expect("list_jobs must work");
    assert_eq!(jobs.len(), 2);
    assert!(
        jobs[0].id > jobs[1].id,
        "list_jobs is newest first, got {:?}",
        jobs.iter().map(|j| j.id).collect::<Vec<_>>()
    );
}

#[test]
fn delete_job_removes_and_reports_missing() {
    let db = test_db();
    let guard = db.lock().unwrap();
    let conn = guard.connection();

    let seed_id: i64 = conn
        .query_row("SELECT id FROM print_jobs LIMIT 1", [], |r| r.get(0))
        .unwrap();

    delete_job_conn(conn, seed_id).expect("delete must work");
    let err = delete_job_conn(conn, seed_id).unwrap_err();
    assert!(
        matches!(err, AppError::NotFound(_)),
        "expected NotFound, got {err:?}"
    );
}
