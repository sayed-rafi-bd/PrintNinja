import { InvalidCredentialsError } from "../errors.js";
import type { AuthDeps, UserRecord } from "../ports.js";
import { handleKey } from "./shared.js";

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
 * cannot be probed. Every login mints a fresh session — v1 behaviour.
 */
export async function loginUser(
  deps: AuthDeps,
  input: LoginInput,
): Promise<LoginResult> {
  const user = await deps.users.findByHandleKey(handleKey(input.handle));
  const passwordHash = user?.passwordHash;
  const ok =
    passwordHash !== undefined &&
    (await deps.hasher.verify(passwordHash, input.password));
  if (!ok || !user) {
    throw new InvalidCredentialsError();
  }

  // D13: a password that verified against a legacy hash is rehashed to
  // the current algorithm now, so the scrypt cost is paid exactly once.
  let record = user;
  if (deps.hasher.needsRehash(passwordHash)) {
    const rehashed = await deps.hasher.hash(input.password);
    await deps.users.updatePasswordHash(user.id, rehashed);
    record = { ...user, passwordHash: rehashed };
  }

  const { token, tokenHash } = deps.tokens.generate();
  const expiresAt = new Date(
    deps.clock.now().getTime() + deps.sessionTtlDays * 86_400_000,
  );
  await deps.sessions.create({ tokenHash, userId: record.id, expiresAt });

  return { user: record, token, expiresAt };
}
