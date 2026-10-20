// Ports (REFACTORING.md section 5): the interfaces the domain needs.
// Infrastructure implements them; unit tests fake them. The domain never
// imports Fastify or Prisma — the layer check enforces it.

import type {
	SavedRepository,
	TemplateRepository,
} from "./templatePorts.js";
import type { SyncRepository } from "./syncPorts.js";

export interface UserRecord {
	id: string;
	handle: string;
	handleKey: string;
	passwordHash: string;
	createdAt: Date;
}

export interface SessionRecord {
	tokenHash: string;
	userId: string;
	expiresAt: Date;
}

export interface UserRepository {
	findByHandleKey(handleKey: string): Promise<UserRecord | null>;
	findById(id: string): Promise<UserRecord | null>;
	/** Creates the user and its user_sync row atomically. Throws
	 * HandleTakenError when the handle key is already taken (covers the
	 * check-then-insert race, not just the pre-check). */
	create(input: {
		id: string;
		handle: string;
		handleKey: string;
		passwordHash: string;
	}): Promise<UserRecord>;
	/** Replaces the stored hash (D13: legacy scrypt rehash on login). */
	updatePasswordHash(id: string, passwordHash: string): Promise<void>;
}

export interface SessionRepository {
	create(input: {
		tokenHash: string;
		userId: string;
		expiresAt: Date;
	}): Promise<SessionRecord>;
	/** The session with its user, for request authentication. */
	findWithUser(
		tokenHash: string,
	): Promise<{ session: SessionRecord; user: UserRecord } | null>;
	/** Logout is idempotent: unknown tokens delete nothing and still succeed. */
	deleteByTokenHash(tokenHash: string): Promise<void>;
	/** Deletes sessions expired at or before now. Returns the count. */
	deleteExpired(now: Date): Promise<number>;
}

export interface PasswordHasher {
	hash(password: string): Promise<string>;
	verify(storedHash: string, password: string): Promise<boolean>;
	/** True when a verified password should be rehashed to the current
	 * algorithm (D13: a legacy scrypt hash pays its 128 MiB/400 ms on
	 * exactly one login, then becomes argon2id). */
	needsRehash(storedHash: string): boolean;
}

export interface TokenService {
	/** 32 random bytes as base64url, plus its SHA-256 hex. The hash is
	 * stored; the token is sent to the client and never stored. */
	generate(): { token: string; tokenHash: string };
	hash(token: string): string;
}

export interface Clock {
	now(): Date;
}

export interface IdGenerator {
	newId(): string;
}

/** Everything the auth domain needs. buildApp wires the real
 * implementations; tests pass fakes. */
export interface AuthDeps {
	users: UserRepository;
	sessions: SessionRepository;
	hasher: PasswordHasher;
	tokens: TokenService;
	clock: Clock;
	ids: IdGenerator;
	/** Days until a new session expires. */
	sessionTtlDays: number;
}

/** Everything the app wires. buildApp takes this whole; tests pass
 * fakes for the parts under test. */
export interface AppDeps extends AuthDeps {
	templates: TemplateRepository;
	saved: SavedRepository;
	sync: SyncRepository;
}
