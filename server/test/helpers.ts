import type { Config } from "../src/config.js";

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
