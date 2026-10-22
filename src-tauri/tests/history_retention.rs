//! History retention: terminal rows older than `retention_days` go,
//! then the oldest beyond `max_records`. Queued and printing rows are
//! never history and are always kept.

use printninja_lib::commands::history::purge_old_jobs;
use printninja_lib::db::Database;
use std::sync::{Arc, Mutex};

type Db = Arc<Mutex<Database>>;

fn test_db() -> Db {
    let path =
        std::env::temp_dir().join(format!("printninja_retention_{}.db", uuid::Uuid::new_v4()));
    Arc::new(Mutex::new(
        Database::open(&format!("sqlite:{}", path.display())).expect("open db"),
    ))
}

fn seed_job(db: &Db, status: &str, created_at: &str) -> i64 {
    let guard = db.lock().unwrap();
    guard
        .connection()
        .execute(
            "INSERT INTO print_jobs (status, created_at) VALUES (?1, ?2)",
            rusqlite::params![status, created_at],
        )
        .unwrap();
    guard.connection().last_insert_rowid()
}

fn set_setting(db: &Db, key: &str, value: &str) {
    let guard = db.lock().unwrap();
    guard
        .connection()
        .execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )
        .unwrap();
}

fn remaining(db: &Db) -> Vec<(i64, String)> {
    let guard = db.lock().unwrap();
    let mut stmt = guard
        .connection()
        .prepare("SELECT id, status FROM print_jobs ORDER BY id")
        .unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

#[test]
fn purges_by_age_but_never_touches_live_rows() {
    let db = test_db();
    let old_ok = seed_job(&db, "success", "2001-01-01 00:00:00");
    let old_queued = seed_job(&db, "queued", "2001-01-01 00:00:00");
    let old_printing = seed_job(&db, "printing", "2001-01-01 00:00:00");
    let fresh_failed = seed_job(&db, "failed", "datetime('now')");

    let (by_age, by_cap) = with_conn(&db, |conn| {
        purge_old_jobs(conn, 30, 10_000).expect("purge works")
    });
    assert_eq!((by_age, by_cap), (1, 0));

    let ids: Vec<i64> = remaining(&db).iter().map(|(id, _)| *id).collect();
    assert!(!ids.contains(&old_ok), "old terminal row is gone");
    assert!(ids.contains(&old_queued), "queued rows are not history");
    assert!(ids.contains(&old_printing), "printing rows are not history");
    assert!(ids.contains(&fresh_failed), "fresh rows stay");
}

#[test]
fn caps_total_rows_oldest_first() {
    let db = test_db();
    let mut ids = Vec::new();
    for day in [
        "2020-01-01 00:00:00",
        "2020-01-02 00:00:00",
        "2020-01-03 00:00:00",
    ] {
        ids.push(seed_job(&db, "success", day));
    }
    // Nothing is older than the horizon here; only the cap bites.
    let (by_age, by_cap) = with_conn(&db, |conn| {
        purge_old_jobs(conn, 3650, 2).expect("purge works")
    });
    assert_eq!((by_age, by_cap), (0, 1));

    let kept: Vec<i64> = remaining(&db).iter().map(|(id, _)| *id).collect();
    assert_eq!(kept.len(), 2);
    assert!(!kept.contains(&ids[0]), "oldest goes first");
    assert!(kept.contains(&ids[1]));
    assert!(kept.contains(&ids[2]));
}

#[test]
fn retention_prefs_default_and_clamp() {
    let db = test_db();
    assert_eq!(read_retention_prefs_conn(&db), (30, 10_000));

    set_setting(&db, "retention_days", "7");
    set_setting(&db, "max_records", "500");
    assert_eq!(read_retention_prefs_conn(&db), (7, 500));

    set_setting(&db, "retention_days", "not-a-number");
    set_setting(&db, "max_records", "0");
    assert_eq!(read_retention_prefs_conn(&db), (30, 10_000));
}

fn with_conn<T>(db: &Db, f: impl FnOnce(&rusqlite::Connection) -> T) -> T {
    let guard = db.lock().unwrap();
    f(guard.connection())
}

fn read_retention_prefs_conn(db: &Db) -> (u32, u32) {
    with_conn(db, printninja_lib::commands::history::read_retention_prefs)
}
