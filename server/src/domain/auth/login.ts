import { InvalidCredentialsError } from "../errors.js";
import type { AuthDeps, UserRecord } from "../ports.js";
import { MAX_SESSIONS_PER_USER } from "./session.js";
import { handleKey } from "./shared.js";

// Argon2id hash of a random string, generated once with production
// parameters (m=19456, t=2, p=1). Unknown handles verify against it so
// the timing matches a real password check. Never a real credential.
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,p=1,t=2$BSHKwZWRmYtcTNE5Gay2Eg$avJrUxjYLTBhKQ/qXa/0KaYxmpMiQ37w0vRTOC3151g";

export interface LoginInput {
  handle: string;
  password: string;
}

export interface LoginResult {
  user: UserRecord;
  token: string;
  expiresAt: Date;
}

/**
 * Signs in with a handle and password. An unknown handle and a wrong
 * password give the identical InvalidCredentialsError (401), so handles
 * cannot be probed — and the unknown-handle path still pays for one
 * hash verification, so the two cases also take the same time.
 * Every login mints a fresh session — v1 behaviour.
 */
export async function loginUser(
  deps: AuthDeps,
  input: LoginInput,
): Promise<LoginResult> {
  const user = await deps.users.findByHandleKey(handleKey(input.handle));
  // Dummy hash with production parameters: verifying a wrong password
  // against it costs the same as the real check, so unknown handles do
  // not answer faster than wrong passwords.
  const ok = await deps.hasher.verify(
    user?.passwordHash ?? DUMMY_HASH,
    input.password,
  );
  if (!ok || !user) {
    throw new InvalidCredentialsError();
  }

  // D13: a password that verified against a legacy hash is rehashed to
  // the current algorithm now, so the scrypt cost is paid exactly once.
  // user is narrowed defined here, so its passwordHash is a string.
  let record = user;
  if (deps.hasher.needsRehash(user.passwordHash)) {
    const rehashed = await deps.hasher.hash(input.password);
    await deps.users.updatePasswordHash(user.id, rehashed);
    record = { ...user, passwordHash: rehashed };
  }

  const { token, tokenHash } = deps.tokens.generate();
  const expiresAt = new Date(
    deps.clock.now().getTime() + deps.sessionTtlDays * 86_400_000,
  );
  await deps.sessions.create({ tokenHash, userId: record.id, expiresAt });
  // Devices log in far more often than they log out; without a cap one
  // user accumulates a session row per login until the TTL purge.
  await deps.sessions.deleteOldestForUser(record.id, MAX_SESSIONS_PER_USER);

  return { user: record, token, expiresAt };
}
