import { InvalidCredentialsError } from "../errors.js";
import type { AuthDeps, UserRecord } from "../ports.js";
import { assertValidPassword } from "./shared.js";
import { revokeOtherSessions } from "./session.js";

/**
 * Password change. The current password must verify (guessing it is
 * no easier than logging in), and every *other* session is revoked:
 * a leaked password stops working everywhere except the device that
 * changed it. Returns the revoked-session count.
 */
export async function changePassword(
  deps: AuthDeps,
  user: UserRecord,
  currentPassword: string,
  newPassword: string,
  currentToken: string,
): Promise<{ revoked: number }> {
  assertValidPassword("new_password", newPassword);
  const ok = await deps.hasher.verify(user.passwordHash, currentPassword);
  if (!ok) {
    throw new InvalidCredentialsError();
  }
  await deps.users.updatePasswordHash(
    user.id,
    await deps.hasher.hash(newPassword),
  );
  const revoked = await revokeOtherSessions(deps, user.id, currentToken);
  return { revoked };
}
