import { randomUUID } from "node:crypto";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { purgeExpiredSessions } from "./domain/auth/index.js";
import type { AuthDeps } from "./domain/ports.js";
import { createDbClient } from "./infra/prisma/client.js";
import { createSessionRepository } from "./infra/prisma/sessions.js";
import { createUserRepository } from "./infra/prisma/users.js";
import { createPasswordHasher } from "./infra/security/passwordHasher.js";
import { createTokenService } from "./infra/security/tokens.js";

// Process entry (REFACTORING.md section 5): load config, build app,
// listen, and shut down cleanly — stop accepting, let in-flight
// requests finish, close the database, then exit. Fail-fast: a bad
// environment aborts here with the offending field named.
const config = loadConfig();
const db = createDbClient(config.databaseUrl);

const deps: AuthDeps = {
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
};

const app = await buildApp({ config, deps });
app.addHook("onClose", async () => {
	await db.$disconnect();
});

// Session cleanup: once at startup, then hourly. No job queue — a timer
// in the process entry is the whole mechanism. buildApp stays
// schedule-free so tests never inherit timers.
const purgedAtStartup = await purgeExpiredSessions(deps);
app.log.info({ purgedAtStartup }, "purged expired sessions at startup");
const cleanupTimer = setInterval(
	() => {
		purgeExpiredSessions(deps).then(
			(purged) => app.log.info({ purged }, "purged expired sessions"),
			(error: unknown) => app.log.error({ err: error }, "session purge failed"),
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
