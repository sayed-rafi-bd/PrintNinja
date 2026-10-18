use chrono::{DateTime, Utc};
use rand::RngCore;
use scrypt::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Scrypt,
};
use sha2::{Digest, Sha256};

use crate::error::AppError;

/// Hash a password with scrypt + per-user salt (PHC string).
pub fn hash_password(password: &str) -> Result<String, AppError> {
    let salt = SaltString::generate(&mut OsRng);
    let hash = Scrypt
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(hash.to_string())
}

/// Verify a password against a stored PHC hash (constant-time).
pub fn verify_password(hash: &str, password: &str) -> bool {
    let parsed = match PasswordHash::new(hash) {
        Ok(h) => h,
        Err(_) => return false,
    };
    Scrypt.verify_password(password.as_bytes(), &parsed).is_ok()
}

/// Generate an opaque session token (32 random bytes, base64url) and its sha256 hash.
/// The hash is what we store; the token is what we send to the client.
pub fn generate_token() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        &bytes,
    );
    let hash = hash_token(&token);
    (token, hash)
}

pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

/// Throttle: 5 attempts per minute per handle and per IP.
#[derive(Default)]
pub struct Throttle {
    // (key, Vec<Instant>)
    inner: std::collections::HashMap<String, Vec<std::time::Instant>>,
}

impl Throttle {
    pub fn check_and_record(&mut self, key: &str) -> Result<(), AppError> {
        let now = std::time::Instant::now();
        let window = std::time::Duration::from_secs(60);
        let entry = self.inner.entry(key.to_string()).or_default();
        // Remove old entries outside window
        entry.retain(|t| now.duration_since(*t) < window);
        if entry.len() >= 5 {
            return Err(AppError::TooManyRequests(
                "Too many attempts, try again later".into(),
            ));
        }
        entry.push(now);
        Ok(())
    }
}

/// Session info returned after auth.
#[derive(Debug, Clone)]
pub struct Session {
    pub user_id: String,
    pub handle: String,
    pub expires_at: DateTime<Utc>,
}

/// Validate Bearer token from header, return session if valid and not expired.
pub fn validate_session(
    conn: &rusqlite::Connection,
    token: &str,
) -> Result<Session, AppError> {
    let hash = hash_token(token);
    let mut stmt = conn
        .prepare(
            "SELECT s.user_id, s.expires_at, u.handle \
             FROM sessions s JOIN users u ON s.user_id = u.id \
             WHERE s.token_hash = ?1",
        )
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let mut rows = stmt
        .query([hash])
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if let Some(row) = rows.next().map_err(|e| AppError::Internal(e.to_string()))? {
        let user_id: String = row.get(0).map_err(|e| AppError::Internal(e.to_string()))?;
        let expires_at_str: String = row.get(1).map_err(|e| AppError::Internal(e.to_string()))?;
        let handle: String = row.get(2).map_err(|e| AppError::Internal(e.to_string()))?;
        let expires_at = expires_at_str
            .parse::<DateTime<Utc>>()
            .or_else(|_| {
                // Try without timezone, assume UTC
                chrono::NaiveDateTime::parse_from_str(&expires_at_str, "%Y-%m-%d %H:%M:%S")
                    .map(|ndt| ndt.and_utc())
            })
            .map_err(|e| AppError::Internal(e.to_string()))?;
        if expires_at < Utc::now() {
            return Err(AppError::Unauthorized("Session expired".into()));
        }
        Ok(Session {
            user_id,
            handle,
            expires_at,
        })
    } else {
        Err(AppError::Unauthorized("Invalid token".into()))
    }
}
