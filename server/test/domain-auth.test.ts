import { describe, expect, it } from "vitest";
import {
  createFakeClock,
  createFakeHasher,
  createFakeIds,
  createFakeSessions,
  createFakeTokens,
  createFakeUsers,
} from "./fakes/index.js";
import {
  changePassword,
  loginUser,
  logoutUser,
  MAX_SESSIONS_PER_USER,
  purgeExpiredSessions,
  registerUser,
  revokeOtherSessions,
  validateSession,
} from "../src/domain/auth/index.js";
import {
  HandleTakenError,
  InvalidCredentialsError,
  UnauthorizedError,
} from "../src/domain/errors.js";
import type { AuthDeps } from "../src/domain/ports.js";

const PASSWORD = "password123";

function deps(): AuthDeps {
  const users = createFakeUsers();
  return {
    users,
    sessions: createFakeSessions(users),
    hasher: createFakeHasher(),
    tokens: createFakeTokens(),
    clock: createFakeClock(new Date("2026-10-20T00:00:00Z")),
    ids: createFakeIds(["user-1", "user-2"]),
    sessionTtlDays: 30,
  };
}

async function registered(deps: AuthDeps, handle = "Alice") {
  return registerUser(deps, { handle, password: PASSWORD });
}

describe("registerUser", () => {
  it("creates the user, keeps the typed handle, and returns a session", async () => {
    const result = await registered(deps());

    expect(result.user.handle).toBe("Alice");
    expect(result.user.id).toBe("user-1");
    expect(result.token).toBe("token-1");
    expect(result.expiresAt.toISOString()).toBe("2026-11-19T00:00:00.000Z");
    expect(result.user.createdAt.toISOString()).toBe(
      "2026-10-20T00:00:00.000Z",
    );
  });

  it("matches the duplicate case-insensitively", async () => {
    const d = deps();
    await registered(d, "Alice");

    await expect(registered(d, "alice")).rejects.toBeInstanceOf(
      HandleTakenError,
    );
    await expect(registered(d, "ALICE")).rejects.toBeInstanceOf(
      HandleTakenError,
    );
  });

  it("rejects an invalid handle or password without touching the store", async () => {
    const d = deps();

    for (const handle of ["", "a".repeat(33), "has space", "semi;colon"]) {
      await expect(
        registerUser(d, { handle, password: PASSWORD }),
      ).rejects.toThrow("handle");
    }
    for (const password of ["short", "a".repeat(129)]) {
      await expect(
        registerUser(d, { handle: "bob", password }),
      ).rejects.toThrow("password");
    }
    expect(await d.users.findByHandleKey("bob")).toBeNull();
  });

  it("trims the handle before storing", async () => {
    const d = deps();
    const result = await registered(d, "  bob  ");

    expect(result.user.handle).toBe("bob");
    await expect(registered(d, "bob")).rejects.toBeInstanceOf(HandleTakenError);
  });

  it("stores a hash, never the password", async () => {
    const d = deps();
    const result = await registered(d);

    const stored = await d.users.findById(result.user.id);
    expect(stored?.passwordHash).not.toBe(PASSWORD);
    expect(stored?.passwordHash).toContain(PASSWORD);
  });
});

describe("loginUser", () => {
  it("returns a new session for the stored handle casing", async () => {
    const d = deps();
    await registered(d, "Alice");

    const result = await loginUser(d, {
      handle: "ALICE",
      password: PASSWORD,
    });

    expect(result.user.handle).toBe("Alice");
    expect(result.token).toBe("token-2");
    expect(result.expiresAt.toISOString()).toBe("2026-11-19T00:00:00.000Z");
  });

  it("gives the same answer for an unknown handle and a wrong password", async () => {
    const d = deps();
    await registered(d, "bob");

    const wrongPassword = loginUser(d, {
      handle: "bob",
      password: "wrongpassword",
    });
    const unknownHandle = loginUser(d, {
      handle: "nobody",
      password: PASSWORD,
    });

    await expect(wrongPassword).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(unknownHandle).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(wrongPassword).rejects.toThrow("Invalid handle or password");
    await expect(unknownHandle).rejects.toThrow("Invalid handle or password");
  });

  it("still verifies a password for an unknown handle (no timing oracle)", async () => {
    const d = deps();
    await registered(d, "bob");
    let verifications = 0;
    const inner = d.hasher.verify.bind(d.hasher);
    d.hasher = {
      ...d.hasher,
      verify: async (storedHash, password) => {
        verifications += 1;
        return inner(storedHash, password);
      },
    };

    await expect(
      loginUser(d, { handle: "nobody", password: PASSWORD }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(verifications).toBe(1);
  });

  it("caps sessions per user, keeping the newest", async () => {
    const d = deps();
    const first = await registered(d, "carol");
    expect(first.token).toBe("token-1");

    let last = "";
    for (let i = 0; i < 25; i++) {
      last = (await loginUser(d, { handle: "carol", password: PASSWORD }))
        .token;
    }

    // 1 register + 25 logins, capped at MAX_SESSIONS_PER_USER.
    const survivors: string[] = [];
    for (let i = 1; i <= 26; i++) {
      const session = await validateSession(d, `token-${i}`).catch(() => null);
      if (session) survivors.push(`token-${i}`);
    }
    expect(survivors).toHaveLength(MAX_SESSIONS_PER_USER);
    expect(survivors).toContain(last);
    expect(survivors).not.toContain("token-1");
  });

  it("rehashes a legacy scrypt password to the current algorithm on login", async () => {
    const d = deps();
    const legacy = "$scrypt$ln=17,r=8,p=1$c2FsdA$bWFzaA";
    await d.users.create({
      id: "user-9",
      handle: "old",
      handleKey: "old",
      passwordHash: legacy,
    });
    // Inline double: the shared fake never produces legacy hashes.
    d.hasher = {
      hash: async (password: string) => `argon2id:${password}`,
      verify: async (storedHash: string, password: string) =>
        storedHash === legacy && password === PASSWORD,
      needsRehash: (storedHash: string) => storedHash.startsWith("$scrypt$"),
    };

    const result = await loginUser(d, { handle: "old", password: PASSWORD });

    expect(result.user.passwordHash).toBe(`argon2id:${PASSWORD}`);
    expect((await d.users.findById("user-9"))?.passwordHash).toBe(
      `argon2id:${PASSWORD}`,
    );
  });
});

describe("logoutUser and validateSession", () => {
  it("validates a live session, then forgets it on logout", async () => {
    const d = deps();
    const { token } = await registered(d);

    const session = await validateSession(d, token);
    expect(session.user.handle).toBe("Alice");

    await logoutUser(d, token);
    await expect(validateSession(d, token)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("logout is idempotent: an unknown token still succeeds", async () => {
    await expect(logoutUser(deps(), "nope")).resolves.toBeUndefined();
  });

  it("revokeOtherSessions keeps the caller and kills the rest", async () => {
    const d = deps();
    const first = await registered(d);
    const second = await loginUser(d, { handle: "Alice", password: PASSWORD });
    expect(second.token).not.toBe(first.token);

    const revoked = await revokeOtherSessions(d, first.user.id, first.token);
    expect(revoked).toBe(1);

    // The caller still validates; the other session is gone.
    await expect(validateSession(d, first.token)).resolves.toMatchObject({
      user: { handle: "Alice" },
    });
    await expect(validateSession(d, second.token)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );

    // Nothing left to revoke is not an error.
    await expect(
      revokeOtherSessions(d, first.user.id, first.token),
    ).resolves.toBe(0);
  });

  it("changePassword needs the current password and revokes the rest", async () => {
    const d = deps();
    const first = await registered(d);
    const second = await loginUser(d, { handle: "Alice", password: PASSWORD });

    // A wrong current password fails like a bad login, changing nothing.
    await expect(
      changePassword(
        d,
        first.user,
        "not-the-password",
        "new-password-1",
        first.token,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(validateSession(d, first.token)).resolves.toBeTruthy();

    const { revoked } = await changePassword(
      d,
      first.user,
      PASSWORD,
      "new-password-1",
      first.token,
    );
    expect(revoked).toBe(1);

    // The new password logs in; the old one does not; the other
    // session died with the change.
    await expect(
      loginUser(d, { handle: "Alice", password: "new-password-1" }),
    ).resolves.toMatchObject({ user: { handle: "Alice" } });
    await expect(
      loginUser(d, { handle: "Alice", password: PASSWORD }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(validateSession(d, second.token)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(validateSession(d, first.token)).resolves.toBeTruthy();
  });

  it("rejects missing, malformed, unknown and expired tokens alike", async () => {
    const d = deps();
    const { token } = await registered(d);

    for (const bad of ["", "not-a-token", "Bearer " + token]) {
      await expect(validateSession(d, bad)).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
    }
    // Expire the session by moving the clock past its TTL.
    d.clock = createFakeClock(new Date("2027-10-20T00:00:00Z"));
    await expect(validateSession(d, token)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });
});

describe("purgeExpiredSessions", () => {
  it("deletes only the expired sessions and reports the count", async () => {
    const d = deps();
    const { token, user } = await registered(d);
    await d.sessions.create({
      tokenHash: "expired-hash",
      userId: user.id,
      expiresAt: new Date("2020-01-01T00:00:00Z"),
    });

    expect(await purgeExpiredSessions(d)).toBe(1);
    await expect(validateSession(d, token)).resolves.toMatchObject({
      user: { id: user.id },
    });
  });

  it("reports zero when nothing is expired", async () => {
    const d = deps();
    await registered(d);

    expect(await purgeExpiredSessions(d)).toBe(0);
  });
});
