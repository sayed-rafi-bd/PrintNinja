import { randomUUID } from "node:crypto";
import type { Config } from "../src/config.js";
import type { AppDeps } from "../src/domain/ports.js";
import {
  createFakeClock,
  createFakeHasher,
  createFakeSessions,
  createFakeTokens,
  createFakeUsers,
} from "./fakes/index.js";
import { createFakeTemplateRepos } from "./fakes/templates.js";
import { createFakeLibraryRepos } from "./fakes/library.js";
import { createFakeAccountRepos } from "./fakes/account.js";

/**
 * Builds a valid Config for tests without touching process.env. Env
 * parsing itself is covered in test/config.test.ts; everything else
 * only needs a Config value.
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 3001,
    databaseUrl: "postgresql://user:pass@localhost:5432/printninja_test",
    logLevel: "error",
    corsOrigins: ["http://localhost:1420", "tauri://localhost"],
    trustProxy: 0,
    sessionTtlDays: 30,
    sessionCleanupMinutes: 60,
    syncTombstoneDays: 90,
    syncPageBytes: 8 * 1024 * 1024,
    rateLimitMax: 120,
    rateLimitAuthMax: 10,
    rateLimitAuthWindowSeconds: 300,
    argon2MemoryKib: 19456,
    argon2TimeCost: 2,
    argon2Parallelism: 1,
    docsEnabled: true,
    ...overrides,
  };
}

/**
 * Full AppDeps with in-memory fakes, for tests that only exercise the
 * HTTP layer (envelope, headers, docs gating). Anything touching real
 * behaviour uses test/integration/ with PostgreSQL instead.
 */
export function fakeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const users = createFakeUsers();
  const library = createFakeTemplateRepos(users);
  const account = createFakeLibraryRepos();
  const accountRepos = createFakeAccountRepos();
  return {
    users,
    sessions: createFakeSessions(users),
    hasher: createFakeHasher(),
    tokens: createFakeTokens(),
    clock: createFakeClock(new Date("2026-10-20T00:00:00Z")),
    ids: { newId: () => randomUUID() },
    sessionTtlDays: 30,
    templates: library.templates,
    saved: library.saved,
    sync: library.sync,
    datasets: account.datasets,
    profiles: account.profiles,
    settings: accountRepos.settings,
    fonts: accountRepos.fonts,
    ...overrides,
  };
}
