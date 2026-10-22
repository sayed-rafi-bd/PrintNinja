import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const positiveInt = z.coerce
  .number({ message: "must be a number" })
  .int()
  .positive();

const port = z.coerce
  .number({ message: "must be a number" })
  .int()
  .min(1)
  .max(65535);

const originList = z.string().transform((value, ctx) => {
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (origins.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "must list at least one origin",
    });
    return z.NEVER;
  }
  for (const origin of origins) {
    try {
      new URL(origin);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: `"${origin}" is not a valid origin URL`,
      });
      return z.NEVER;
    }
  }
  return origins;
});

const configSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: port.default(3001),
    // Local `file:` database for development and tests, Turso Cloud
    // (`libsql://` + DATABASE_AUTH_TOKEN) in production.
    DATABASE_URL: z.string().min(1),
    DATABASE_AUTH_TOKEN: z.string().optional(),
    // Shared secret for the scheduled cleanup endpoint
    // (`GET /v2/internal/cleanup`). Unset disables the endpoint (404).
    CRON_SECRET: z.string().min(1).optional(),
    LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error", "fatal"])
      .default("info"),
    CORS_ORIGINS: originList,
    /**
     * Number of reverse-proxy hops to trust for the client IP (0 = none).
     * Deliberately numeric, not a bare boolean: the deployed shape decides.
     */
    TRUST_PROXY: z.coerce
      .number({ message: "must be a number" })
      .int()
      .min(0)
      .default(0),
    SESSION_TTL_DAYS: positiveInt.default(30),
    SESSION_CLEANUP_MINUTES: positiveInt.default(60),
    /** Days tombstones are kept before the hourly cleanup purges them.
     * A cursor older than the oldest kept tombstone gets reset: true. */
    SYNC_TOMBSTONE_DAYS: positiveInt.default(90),
    /** Per-page byte budget for the sync stream. Pages stop at the
     * record limit or this budget, whichever is first. */
    SYNC_PAGE_BYTES: positiveInt.default(8 * 1024 * 1024),
    RATE_LIMIT_MAX: positiveInt.default(120),
    RATE_LIMIT_AUTH_MAX: positiveInt.default(10),
    RATE_LIMIT_AUTH_WINDOW_SECONDS: positiveInt.default(300),
    ARGON2_MEMORY_KIB: positiveInt.max(262144).default(19456),
    ARGON2_TIME_COST: positiveInt.max(8).default(2),
    ARGON2_PARALLELISM: positiveInt.max(8).default(1),
    // prefault, not default: Zod 4 defaults skip the enum/transform
    DOCS_ENABLED: booleanFromString.prefault("false"),
  })
  .refine(
    (parsed) =>
      !parsed.DATABASE_URL.startsWith("libsql:") ||
      (parsed.DATABASE_AUTH_TOKEN ?? "").length > 0,
    { message: "DATABASE_AUTH_TOKEN: required for a libsql:// DATABASE_URL" },
  );

export type Config = {
  nodeEnv: "development" | "production" | "test";
  host: string;
  port: number;
  databaseUrl: string;
  databaseAuthToken?: string;
  cronSecret?: string;
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  corsOrigins: string[];
  trustProxy: number;
  sessionTtlDays: number;
  sessionCleanupMinutes: number;
  syncTombstoneDays: number;
  syncPageBytes: number;
  rateLimitMax: number;
  rateLimitAuthMax: number;
  rateLimitAuthWindowSeconds: number;
  argon2MemoryKib: number;
  argon2TimeCost: number;
  argon2Parallelism: number;
  docsEnabled: boolean;
};

/**
 * Reads configuration from the given environment (defaults to
 * process.env) and fails fast with a message that names every invalid
 * or missing field. Nothing is loaded automatically: development runs
 * pass --env-file, tests pass an object.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const field = issue.path.join(".") || "(root)";
        return issue.message === "Invalid input"
          ? field
          : `${field}: ${issue.message}`;
      })
      .join("; ");
    throw new Error(`Invalid environment configuration — ${details}`);
  }
  const parsed = result.data;
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    databaseAuthToken: parsed.DATABASE_AUTH_TOKEN,
    cronSecret: parsed.CRON_SECRET,
    logLevel: parsed.LOG_LEVEL,
    corsOrigins: parsed.CORS_ORIGINS,
    trustProxy: parsed.TRUST_PROXY,
    sessionTtlDays: parsed.SESSION_TTL_DAYS,
    sessionCleanupMinutes: parsed.SESSION_CLEANUP_MINUTES,
    syncTombstoneDays: parsed.SYNC_TOMBSTONE_DAYS,
    syncPageBytes: parsed.SYNC_PAGE_BYTES,
    rateLimitMax: parsed.RATE_LIMIT_MAX,
    rateLimitAuthMax: parsed.RATE_LIMIT_AUTH_MAX,
    rateLimitAuthWindowSeconds: parsed.RATE_LIMIT_AUTH_WINDOW_SECONDS,
    argon2MemoryKib: parsed.ARGON2_MEMORY_KIB,
    argon2TimeCost: parsed.ARGON2_TIME_COST,
    argon2Parallelism: parsed.ARGON2_PARALLELISM,
    docsEnabled: parsed.DOCS_ENABLED,
  };
}
