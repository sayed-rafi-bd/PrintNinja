import { createHash, randomBytes } from "node:crypto";
import type { TokenService } from "../../domain/ports.js";

/**
 * Opaque session tokens: 32 random bytes as base64url, stored as
 * SHA-256 hex. The same shape as the Rust server, so imported sessions
 * keep working — the token is opaque and the hash function is unchanged.
 */
export function createTokenService(): TokenService {
  return {
    generate() {
      const token = randomBytes(32).toString("base64url");
      return { token, tokenHash: hashToken(token) };
    },
    hash(token) {
      return hashToken(token);
    },
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
