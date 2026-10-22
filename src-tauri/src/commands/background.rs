use crate::db::DbState;
use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use tauri::{AppHandle, Manager, State};

/// Background-behavior preferences, mirrored from the `settings` table.
/// Every key defaults to off except close-to-tray, which keeps the print
/// queue alive when the window is closed. Autostart itself stays opt-in.
pub const KEY_LAUNCH_AT_STARTUP: &str = "launch_at_startup";
pub const KEY_START_MINIMIZED: &str = "start_minimized";
pub const KEY_MINIMIZE_TO_TRAY: &str = "minimize_to_tray";
pub const KEY_CLOSE_TO_TRAY: &str = "close_to_tray";

#[derive(Debug, Clone, Copy, Default)]
pub struct BackgroundPrefs {
    pub launch_at_startup: bool,
    pub start_minimized: bool,
    pub minimize_to_tray: bool,
    pub close_to_tray: bool,
}

impl BackgroundPrefs {
    pub fn read(conn: &Connection) -> AppResult<Self> {
        let get = |key: &str| -> AppResult<bool> {
            let raw: Option<String> = conn
                .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                    r.get(0)
                })
                .ok();
            Ok(matches!(raw.as_deref(), Some("1" | "true")))
        };
        Ok(Self {
            launch_at_startup: get(KEY_LAUNCH_AT_STARTUP)?,
            start_minimized: get(KEY_START_MINIMIZED)?,
            minimize_to_tray: get(KEY_MINIMIZE_TO_TRAY)?,
            // Close-to-tray is the one default-on behavior: closing the
            // window must not kill queued prints unless the user opts out.
            close_to_tray: conn
                .query_row(
                    "SELECT value FROM settings WHERE key = ?1",
                    [KEY_CLOSE_TO_TRAY],
                    |r| r.get::<_, String>(0),
                )
                .ok()
                .map(|v| matches!(v.as_str(), "1" | "true"))
                .unwrap_or(true),
        })
    }
}

/// Re-reads the background preferences from the DB and applies the OS
/// side: autostart registration on/off. The frontend calls this after
/// writing any of the four keys so the change takes effect without a
/// restart. Tray visibility itself is decided per window event.
#[tauri::command]
pub fn refresh_background(app: AppHandle, db: State<DbState>) -> AppResult<()> {
    let prefs = {
        let guard = db
            .lock()
            .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
        BackgroundPrefs::read(guard.connection())?
    };
    apply_autostart(&app, prefs.launch_at_startup)
}

/// Applies autostart registration on desktop. On mobile there is no
/// OS autostart entry to manage (the foreground service covers it),
/// so this is a successful no-op there.
pub fn apply_autostart(app: &AppHandle, enabled: bool) -> AppResult<()> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt as _;
        let launcher = app.autolaunch();
        let current = launcher
            .is_enabled()
            .map_err(|e| AppError::Internal(format!("autostart state failed: {e}")))?;
        if enabled && !current {
            launcher
                .enable()
                .map_err(|e| AppError::Internal(format!("autostart enable failed: {e}")))?;
        } else if !enabled && current {
            launcher
                .disable()
                .map_err(|e| AppError::Internal(format!("autostart disable failed: {e}")))?;
        }
    }
    #[cfg(not(desktop))]
    let _ = (app, enabled);
    Ok(())
}

pub fn read_prefs(app: &AppHandle) -> BackgroundPrefs {
    app.state::<DbState>()
        .lock()
        .ok()
        .and_then(|guard| BackgroundPrefs::read(guard.connection()).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use std::sync::{Arc, Mutex};

    fn test_db() -> DbState {
        let path =
            std::env::temp_dir().join(format!("printninja_background_{}.db", uuid::Uuid::new_v4()));
        Arc::new(Mutex::new(
            Database::open(&format!("sqlite:{}", path.display())).expect("open db"),
        ))
    }

    fn read(db: &DbState) -> BackgroundPrefs {
        let guard = db.lock().unwrap();
        BackgroundPrefs::read(guard.connection()).unwrap()
    }

    fn write(db: &DbState, key: &str, value: &str) {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [key, value],
            )
            .unwrap();
    }

    /// Fresh installs keep the queue on close (default-on) and
    /// autostart nothing (opt-in).
    #[test]
    fn fresh_install_defaults_keep_printing_without_autostart() {
        let db = test_db();
        let prefs = read(&db);
        assert!(prefs.close_to_tray);
        assert!(!prefs.launch_at_startup);
        assert!(!prefs.start_minimized);
        assert!(!prefs.minimize_to_tray);
    }

    /// Stored values round-trip, including explicit opt-out of the
    /// close-to-tray default.
    #[test]
    fn stored_preferences_win_over_defaults() {
        let db = test_db();
        write(&db, KEY_LAUNCH_AT_STARTUP, "1");
        write(&db, KEY_CLOSE_TO_TRAY, "0");
        write(&db, KEY_MINIMIZE_TO_TRAY, "true");
        let prefs = read(&db);
        assert!(prefs.launch_at_startup);
        assert!(!prefs.close_to_tray);
        assert!(prefs.minimize_to_tray);
        assert!(!prefs.start_minimized);
    }
}
