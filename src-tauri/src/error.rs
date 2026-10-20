use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(String),
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Validation error: {0}")]
    Validation(String),
    #[error("Internal error: {0}")]
    Internal(String),
    /// The idempotency key was already taken by another job row — the loser
    /// of a two-simultaneous-requests race gets the existing job id (P12).
    #[error("Idempotency key already used by job {0}")]
    DuplicateJob(i64),
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Database(e.to_string())
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
