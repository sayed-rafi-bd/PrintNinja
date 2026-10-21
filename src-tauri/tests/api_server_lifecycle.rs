//! Lifecycle coverage for the local REST API server commands that the
//! HTTP-level suite (api_routes.rs) cannot reach: port binding,
//! key rotation and status reporting live in Tauri commands, so these
//! tests drive the extracted helpers against a real database.

use printninja_lib::commands::api::{
    api_status_from_db, bind_addr, rotate_api_key, verify_api_key,
};
use printninja_lib::db::Database;
use std::sync::{Arc, Mutex};

type Db = Arc<Mutex<Database>>;

fn test_db() -> Db {
    let path =
        std::env::temp_dir().join(format!("printninja_api_life_{}.db", uuid::Uuid::new_v4()));
    Arc::new(Mutex::new(
        Database::open(&format!("sqlite:{}", path.display())).expect("open db"),
    ))
}

fn with_conn<T>(db: &Db, f: impl FnOnce(&rusqlite::Connection) -> T) -> T {
    let guard = db.lock().unwrap();
    f(guard.connection())
}

/// A busy port fails fast with the address in the message — the UI
/// shows this instead of a silent spawn failure.
#[tokio::test]
async fn a_busy_port_fails_with_the_address_in_the_message() {
    let held = std::net::TcpListener::bind("127.0.0.1:0").expect("ephemeral port");
    let port = held.local_addr().expect("addr").port();
    let addr = format!("127.0.0.1:{port}");

    let err = bind_addr(&addr).expect_err("occupied port must fail");
    let msg = format!("{err:#}");
    assert!(
        msg.contains(&format!("Cannot bind {addr}")),
        "names the busy address: {msg}"
    );

    // The helper binds fine when the port is free.
    drop(held);
    let _listener = bind_addr(&addr).expect("free port binds");
}

/// Rotating the key replaces the row: the new plaintext verifies and
/// the old one stops immediately — a leaked key dies on regenerate.
#[test]
fn key_rotation_invalidates_the_previous_key() {
    let db = test_db();
    let first = with_conn(&db, rotate_api_key).expect("first key");
    assert!(with_conn(&db, |c| verify_api_key(c, &first)));
    let second = with_conn(&db, rotate_api_key).expect("second key");
    assert_ne!(first, second, "rotation mints a fresh secret");
    assert!(with_conn(&db, |c| verify_api_key(c, &second)));
    assert!(
        !with_conn(&db, |c| verify_api_key(c, &first)),
        "the old key stops verifying at once"
    );
}

/// Status reports settings defaults until the user changes them, and
/// the running flag passed in — the UI polls this to show Stop/Start.
#[test]
fn status_reports_settings_and_the_running_flag() {
    let db = test_db();
    let idle = with_conn(&db, |c| api_status_from_db(c, false));
    assert_eq!(idle.port, 17717);
    assert_eq!(idle.address, "127.0.0.1");
    assert!(!idle.lan_access);
    assert!(!idle.running);

    with_conn(&db, |c| {
        for (key, value) in [
            ("api_port", "1888"),
            ("api_lan_access", "true"),
            ("api_bind", "0.0.0.0"),
        ] {
            c.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [key, value],
            )
            .unwrap();
        }
    });
    let live = with_conn(&db, |c| api_status_from_db(c, true));
    assert_eq!(live.port, 1888);
    assert_eq!(live.address, "0.0.0.0");
    assert!(live.lan_access);
    assert!(live.running);

    // LAN on but never started: the default bind follows the LAN flag.
    with_conn(&db, |c| {
        c.execute("DELETE FROM settings WHERE key = 'api_bind'", [])
            .unwrap()
    });
    let lan_default = with_conn(&db, |c| api_status_from_db(c, false));
    assert_eq!(lan_default.address, "0.0.0.0");
}
