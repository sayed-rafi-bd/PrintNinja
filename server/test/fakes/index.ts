import { HandleTakenError } from "../../src/domain/errors.js";
import type {
  Clock,
  IdGenerator,
  PasswordHasher,
  SessionRecord,
  SessionRepository,
  TokenService,
  UserRecord,
  UserRepository,
} from "../../src/domain/ports.js";

// In-memory ports for domain unit tests (REFACTORING.md section 5).
// Behaviour matches the contracts in domain/ports.ts, including the
// duplicate-handle race mapping. Anything slower or more real (Postgres,
// argon2) belongs in test/integration/.

export function createFakeUsers(): UserRepository & {
  byId: Map<string, UserRecord>;
} {
  const byId = new Map<string, UserRecord>();
  const byKey = new Map<string, UserRecord>();
  return {
    byId,
    async findByHandleKey(handleKey) {
      return byKey.get(handleKey) ?? null;
    },
    async findById(id) {
      return byId.get(id) ?? null;
    },
    async create(input) {
      if (byKey.has(input.handleKey)) {
        throw new HandleTakenError();
      }
      const user: UserRecord = {
        ...input,
        createdAt: new Date("2026-10-20T00:00:00Z"),
      };
      byId.set(user.id, user);
      byKey.set(user.handleKey, user);
      return user;
    },
    async updatePasswordHash(id, passwordHash) {
      const user = byId.get(id);
      if (user) {
        byId.set(id, { ...user, passwordHash });
        byKey.set(user.handleKey, { ...user, passwordHash });
      }
    },
  };
}

export function createFakeSessions(users: {
  byId: Map<string, UserRecord>;
}): SessionRepository {
  const byHash = new Map<string, SessionRecord>();
  return {
    async create(input) {
      const session: SessionRecord = { ...input };
      byHash.set(session.tokenHash, session);
      return session;
    },
    async findWithUser(tokenHash) {
      const session = byHash.get(tokenHash) ?? null;
      if (!session) {
        return null;
      }
      const user = users.byId.get(session.userId) ?? null;
      if (!user) {
        return null;
      }
      return { session, user };
    },
    async deleteByTokenHash(tokenHash) {
      byHash.delete(tokenHash);
    },
    async deleteExpired(now) {
      let count = 0;
      for (const [hash, session] of byHash) {
        if (session.expiresAt <= now) {
          byHash.delete(hash);
          count += 1;
        }
      }
      return count;
    },
  };
}

export function createFakeHasher(): PasswordHasher {
  return {
    async hash(password) {
      return `fake-hash:${password}`;
    },
    async verify(storedHash, password) {
      return storedHash === `fake-hash:${password}`;
    },
    needsRehash(storedHash) {
      return !storedHash.startsWith("fake-hash:");
    },
  };
}

export function createFakeTokens(): TokenService & { count: number } {
  let count = 0;
  const service: TokenService & { count: number } = {
    count: 0,
    generate() {
      count += 1;
      service.count = count;
      return {
        token: `token-${count}`,
        tokenHash: `hash-of:token-${count}`,
      };
    },
    hash(token) {
      return `hash-of:${token}`;
    },
  };
  return service;
}

export function createFakeClock(fixed: Date): Clock {
  return { now: () => new Date(fixed) };
}

export function createFakeIds(ids: string[]): IdGenerator {
  const queue = [...ids];
  return {
    newId() {
      const next = queue.shift();
      if (!next) {
        throw new Error("fake ids exhausted");
      }
      return next;
    },
  };
}
