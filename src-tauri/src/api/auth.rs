use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// API key structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKey {
    pub id: i64,
    pub name: String,
    pub key_hash: String,
    pub scopes: Vec<String>,
    pub allowed_ips: Vec<String>,
}

impl ApiKey {
    pub fn generate() -> (String, String) {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let key: String = (0..32)
            .map(|_| rng.sample(rand::distributions::Alphanumeric) as char)
            .collect();
        let prefixed = format!("pn_live_{}", key);
        let hash = hash_key(&prefixed);
        (prefixed, hash)
    }

    pub fn check_scope(&self, scope: &str) -> bool {
        self.scopes.iter().any(|s| s == scope || s == "admin")
    }
}

pub fn hash_key(key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    let result = hasher.finalize();
    hex::encode(result)
}

pub fn verify_key(key: &str, hash: &str) -> bool {
    let computed = hash_key(key);
    // `==` short-circuits on the first differing byte, leaking the prefix
    // length via timing. Use a constant-time compare instead.
    if computed.len() != hash.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in computed.as_bytes().iter().zip(hash.as_bytes()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// Rate limiter (simple token bucket)
pub struct RateLimiter {
    max_tokens: u32,
    tokens: u32,
    last_refill: std::time::Instant,
    refill_rate: u32, // tokens per second
}

impl RateLimiter {
    pub fn new(max_tokens: u32, refill_rate: u32) -> Self {
        Self {
            max_tokens,
            tokens: max_tokens,
            last_refill: std::time::Instant::now(),
            refill_rate,
        }
    }

    pub fn check(&mut self) -> bool {
        let now = std::time::Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs() as u32;
        self.tokens = (self.tokens + elapsed * self.refill_rate).min(self.max_tokens);
        self.last_refill = now;

        if self.tokens > 0 {
            self.tokens -= 1;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_key_accepts_correct_key() {
        let (plain, hash) = ApiKey::generate();
        assert!(verify_key(&plain, &hash));
        assert_eq!(hash_key(&plain), hash);
    }

    #[test]
    fn verify_key_rejects_wrong_key() {
        let (plain, hash) = ApiKey::generate();
        assert!(!verify_key("pn_live_wrongkey00000000000000000000", &hash));
        // Even a one-char difference must fail.
        let mut almost = plain.clone();
        let last = almost.pop().unwrap();
        almost.push(if last == 'a' { 'b' } else { 'a' });
        assert!(!verify_key(&almost, &hash));
    }

    #[test]
    fn verify_key_rejects_different_length() {
        let (_, hash) = ApiKey::generate();
        assert!(!verify_key("short", &hash));
        assert!(!verify_key("x", ""));
        assert!(!verify_key("", &hash));
    }

    #[test]
    fn hash_key_is_deterministic_and_hex() {
        let h1 = hash_key("hello");
        let h2 = hash_key("hello");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
        assert!(h1.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(h1, hash_key("world"));
    }

    #[test]
    fn generated_key_has_expected_format() {
        let (plain, hash) = ApiKey::generate();
        assert!(plain.starts_with("pn_live_"));
        assert_eq!(plain.len(), 40);
        assert_eq!(hash.len(), 64);
    }
}
