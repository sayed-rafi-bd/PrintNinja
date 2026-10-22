import { UnauthorizedError } from "../errors.js";
import type { AuthDeps, UserRecord } from "../ports.js";

/**
 * Sessions kept per user. Logins mint a row each; devices rarely log
 * out, so without pruning one user grows a row per login until the
 * 30-day TTL purge. 20 covers a phone, a tablet, a desktop and plenty
 * of reinstalls.
 */
export const MAX_SESSIONS_PER_USER = 20;

export interface SessionResult {
  user: UserRecord;
}

/**
 * Resolves a bearer token to its user. Missing, malformed, unknown and
 * expired tokens all give the same UnauthorizedError (401) — the route
 * must not distinguish them.
 */
export async function validateSession(
  deps: AuthDeps,
  token: string,
): Promise<SessionResult> {
  if (!token || /\s/.test(token)) {
    throw new UnauthorizedError();
  }
  const found = await deps.sessions.findWithUser(deps.tokens.hash(token));
  if (!found || found.session.expiresAt <= deps.clock.now()) {
    throw new UnauthorizedError();
  }
  return { user: found.user };
}

/**
 * Ends one session. Idempotent: an unknown token deletes nothing and
 * still succeeds, so a retried logout is a 204, not a 404.
 */
export async function logoutUser(deps: AuthDeps, token: string): Promise<void> {
  if (!token || /\s/.test(token)) {
    throw new UnauthorizedError();
  }
  await deps.sessions.deleteByTokenHash(deps.tokens.hash(token));
}

/**
 * Ends every session of a user except the calling one. After a password
 * change (or a lost device) this is how the account is taken back: the
 * current token keeps working, everything else 401s on next use.
 */
export async function revokeOtherSessions(
  deps: AuthDeps,
  userId: string,
  currentToken: string,
): Promise<number> {
  return deps.sessions.deleteOthersForUser(
    userId,
    deps.tokens.hash(currentToken),
  );
}

/**
 * Deletes sessions expired at or before now. Runs at startup and on the
 * hourly timer (no job queue); tombstones are Phase 2's stream, so
 * sessions are all this pass touches.
 */
export async function purgeExpiredSessions(
  deps: Pick<AuthDeps, "sessions" | "clock">,
): Promise<number> {
  return deps.sessions.deleteExpired(deps.clock.now());
}
