import { randomUUID } from "node:crypto";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { purgeExpiredSessions } from "./domain/auth/index.js";
import { purgeOldTombstones } from "./domain/sync/index.js";
import type { AppDeps } from "./domain/ports.js";
import { createDbClient } from "./infra/prisma/client.js";
import { createDatasetRepository } from "./infra/prisma/datasets.js";
import { createSettingRepository } from "./infra/prisma/settings.js";
import { createFontRepository } from "./infra/prisma/fonts.js";
import { createProfileRepository } from "./infra/prisma/profiles.js";
import { createSavedRepository } from "./infra/prisma/saved.js";
import { createSessionRepository } from "./infra/prisma/sessions.js";
import { createSyncRepository } from "./infra/prisma/sync.js";
import { createTemplateRepository } from "./infra/prisma/templates.js";
import { createUserRepository } from "./infra/prisma/users.js";
import { createPasswordHasher } from "./infra/security/passwordHasher.js";
import { createTokenService } from "./infra/security/tokens.js";

// Process entry (REFACTORING.md section 5): load config, build app,
// listen, and shut down cleanly — stop accepting, let in-flight
// requests finish, close the database, then exit. Fail-fast: a bad
// environment aborts here with the offending field named.
const config = loadConfig();
const db = createDbClient(config.databaseUrl);

const deps: AppDeps = {
	users: createUserRepository(db),
	sessions: createSessionRepository(db),
	hasher: createPasswordHasher({
		memoryKib: config.argon2MemoryKib,
		timeCost: config.argon2TimeCost,
		parallelism: config.argon2Parallelism,
	}),
	tokens: createTokenService(),
	clock: { now: () => new Date() },
	ids: { newId: () => randomUUID() },
	sessionTtlDays: config.sessionTtlDays,
	templates: createTemplateRepository(db),
	datasets: createDatasetRepository(db),
	profiles: createProfileRepository(db),
	settings: createSettingRepository(db),
	fonts: createFontRepository(db),
	saved: createSavedRepository(db),
	sync: createSyncRepository(db),
};

const app = await buildApp({ config, deps });
app.addHook("onClose", async () => {
	await db.$disconnect();
});

// Cleanup: once at startup, then hourly. Sessions past their TTL go, and
// tombstones older than the retention window go (their absence is what
// lets a stale cursor answer reset instead of silently missing deletes).
// No job queue — a timer in the process entry is the whole mechanism.
// buildApp stays schedule-free so tests never inherit timers.
const purgedSessionsAtStartup = await purgeExpiredSessions(deps);
const purgedTombstonesAtStartup = await purgeOldTombstones(deps, new Date(), config.syncTombstoneDays);
app.log.info({ purgedSessionsAtStartup, purgedTombstonesAtStartup }, "purged at startup");
const cleanupTimer = setInterval(
	() => {
		purgeExpiredSessions(deps).then(
			(purged) => app.log.info({ purged }, "purged expired sessions"),
			(error: unknown) => app.log.error({ err: error }, "session purge failed"),
		);
		purgeOldTombstones(deps, new Date(), config.syncTombstoneDays).then(
			(purged) => app.log.info({ purged }, "purged old tombstones"),
			(error: unknown) => app.log.error({ err: error }, "tombstone purge failed"),
		);
	},
	config.sessionCleanupMinutes * 60_000,
);
app.addHook("onClose", async () => {
	clearInterval(cleanupTimer);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		app.log.info({ signal }, "shutting down");
		app
			.close()
			.then(() => process.exit(0))
			.catch((error: unknown) => {
				app.log.error({ err: error }, "error during shutdown");
				process.exit(1);
			});
	});
}

await app.listen({ port: config.port, host: config.host });
