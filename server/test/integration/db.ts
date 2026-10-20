import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { AppDeps } from "../../src/domain/ports.js";
import { createDbClient, type DbClient } from "../../src/infra/prisma/client.js";
import { createSavedRepository } from "../../src/infra/prisma/saved.js";
import { createSessionRepository } from "../../src/infra/prisma/sessions.js";
import { createSyncRepository } from "../../src/infra/prisma/sync.js";
import { createTemplateRepository } from "../../src/infra/prisma/templates.js";
import { createDatasetRepository } from "../../src/infra/prisma/datasets.js";
import { createProfileRepository } from "../../src/infra/prisma/profiles.js";
import { createUserRepository } from "../../src/infra/prisma/users.js";
import { createPasswordHasher } from "../../src/infra/security/passwordHasher.js";
import { createTokenService } from "../../src/infra/security/tokens.js";
import { testConfig } from "../helpers.js";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface TestStack {
	db: DbClient;
	stop: () => Promise<void>;
}

/**
 * One PostgreSQL per test file (Testcontainers, postgres:16 — the image
 * CI and developers already have). Migrations run through
 * `prisma migrate deploy`, so integration always exercises the
 * committed migration files, never a hand-built schema.
 */
export async function startTestDatabase(): Promise<TestStack> {
	const container = await new PostgreSqlContainer("postgres:16").start();
	const url = container.getConnectionUri();
	execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
		env: { ...process.env, DATABASE_URL: url },
		stdio: "pipe",
		cwd: serverDir,
		timeout: 120_000,
	});
	const db = createDbClient(url);
	return {
		db,
		stop: async () => {
			await db.$disconnect();
			await container.stop();
		},
	};
}

/** Wipes every table; sessions and user_sync cascade from users. */
export async function truncateAll(db: DbClient): Promise<void> {
	await db.$executeRawUnsafe('TRUNCATE "users", "tombstones" CASCADE');
}

/** Production-shaped deps over the test database. Argon2 uses the
 * configured (production) parameters — register and login stay fast
 * enough to run unlowered, which is itself the point. */
export function realDeps(db: DbClient): AppDeps {
	const config = testConfig();
	return {
		users: createUserRepository(db),
		sessions: createSessionRepository(db),
		hasher: createPasswordHasher({
			memoryKib: config.argon2MemoryKib,
			timeCost: config.argon2TimeCost,
			parallelism: config.argon2Parallelism,
		}),
		tokens: createTokenService(),
		clock: { now: () => new Date() },
		ids: { newId: () => crypto.randomUUID() },
		sessionTtlDays: config.sessionTtlDays,
		templates: createTemplateRepository(db),
		datasets: createDatasetRepository(db),
		profiles: createProfileRepository(db),
		saved: createSavedRepository(db),
		sync: createSyncRepository(db),
	};
}
