import { UnauthorizedError } from "../errors.js";
import type { AuthDeps, UserRecord } from "../ports.js";

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
 * Deletes sessions expired at or before now. Runs at startup and on the
 * hourly timer (no job queue); tombstones are Phase 2's stream, so
 * sessions are all this pass touches.
 */
export async function purgeExpiredSessions(
  deps: Pick<AuthDeps, "sessions" | "clock">,
): Promise<number> {
  return deps.sessions.deleteExpired(deps.clock.now());
}
