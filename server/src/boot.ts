import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import type { AppDeps } from "./domain/ports.js";
import { createDbClient, type DbClient } from "./infra/db/client.js";
import { createDatasetRepository } from "./infra/db/datasets.js";
import { createSettingRepository } from "./infra/db/settings.js";
import { createFontRepository } from "./infra/db/fonts.js";
import { createProfileRepository } from "./infra/db/profiles.js";
import { createSavedRepository } from "./infra/db/saved.js";
import { createSessionRepository } from "./infra/db/sessions.js";
import { createSyncRepository } from "./infra/db/sync.js";
import { createTemplateRepository } from "./infra/db/templates.js";
import { createUserRepository } from "./infra/db/users.js";
import { createPasswordHasher } from "./infra/security/passwordHasher.js";
import { createTokenService } from "./infra/security/tokens.js";

export interface Stack {
  app: FastifyInstance;
  config: Config;
  db: DbClient;
  deps: AppDeps;
  /** Stops accepting, lets in-flight requests finish, closes the database. */
  close: () => Promise<void>;
}

// Shared wiring for every entry point (REFACTORING.md section 5):
// load config, build the database client, the repository deps and the
// app. Fail-fast: a bad environment aborts here with the offending
// field named. Scheduling (timers), startup purges and listening stay
// with the long-lived entries (server.ts); the serverless entry
// (api/index.ts) builds the stack and serves requests only.
export async function buildStack(): Promise<Stack> {
  const config = loadConfig();
  const db = createDbClient(config.databaseUrl, config.databaseAuthToken);

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
    ping: () => db.$queryRaw`SELECT 1`.then(() => undefined),
  };

  const app = await buildApp({ config, deps });
  app.addHook("onClose", async () => {
    await db.$disconnect();
  });
  return {
    app,
    config,
    db,
    deps,
    close: () => app.close(),
  };
}
