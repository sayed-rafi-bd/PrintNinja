import { HandleTakenError } from "../errors.js";
import type { AuthDeps, UserRecord } from "../ports.js";
import { assertValidHandle, assertValidPassword, handleKey } from "./shared.js";

export interface RegisterInput {
  handle: string;
  password: string;
}

export interface RegisterResult {
  user: UserRecord;
  token: string;
  expiresAt: Date;
}

/**
 * Creates the account, its change-sequence row and its first session in
 * one repository transaction. 201 semantics: a new session every time.
 * Throws HandleTakenError (409) for a taken handle, ValidationError
 * (400) for a bad handle or password. No throttle here — the route's
 * rate limit stands in front of this.
 */
export async function registerUser(
  deps: AuthDeps,
  input: RegisterInput,
): Promise<RegisterResult> {
  assertValidHandle("handle", input.handle);
  assertValidPassword("password", input.password);

  const handle = input.handle.trim();
  const key = handleKey(input.handle);
  const existing = await deps.users.findByHandleKey(key);
  if (existing) {
    throw new HandleTakenError();
  }

  const passwordHash = await deps.hasher.hash(input.password);
  // The repository maps a unique-violation on the concurrent-insert
  // race to the same HandleTakenError, so two simultaneous registers
  // of one handle still get one 409 and one 201.
  const user = await deps.users.create({
    id: deps.ids.newId(),
    handle,
    handleKey: key,
    passwordHash,
  });

  const { token, tokenHash } = deps.tokens.generate();
  const expiresAt = new Date(
    deps.clock.now().getTime() + deps.sessionTtlDays * 86_400_000,
  );
  await deps.sessions.create({ tokenHash, userId: user.id, expiresAt });

  return { user, token, expiresAt };
}
