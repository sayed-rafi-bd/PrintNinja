import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { loadEnvFile } from "../../config.js";
import { describeDatabaseUrl } from "./describe-url.js";

// Applies pending migrations from prisma/migrations/ in filename order,
// recording them in the `_prisma_migrations` table (same shape Prisma
// itself uses, so `prisma migrate dev` stays the authoring tool and this
// runner stays the only apply path). `prisma migrate deploy` cannot reach
// a remote Turso database, but this runs the same SQL through the libSQL
// client — identical for `file:` and `libsql://` URLs.
//
// Each migration applies atomically inside one write transaction; an
// already-applied migration whose file changed fails fast instead of
// silently diverging. Concurrent boots race on the table lock: SQLite
// serializes the writers, so the loser sees the migration as applied.

export interface MigrateOptions {
  url: string;
  authToken?: string;
  migrationsDir?: string;
}

const here = dirname(fileURLToPath(import.meta.url));

export function defaultMigrationsDir(): string {
  // src/infra/db/ -> server root, in both tsx (src) and node (dist).
  return resolve(here, "..", "..", "..", "prisma", "migrations");
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export async function applyMigrations(
  options: MigrateOptions,
): Promise<string[]> {
  const { url, authToken, migrationsDir = defaultMigrationsDir() } = options;
  const names = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const client = createClient({ url, authToken });
  try {
    await client.execute(
      `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "checksum" TEXT NOT NULL,
        "finished_at" DATETIME,
        "migration_name" TEXT NOT NULL,
        "logs" TEXT,
        "rolled_back_at" DATETIME,
        "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "applied_steps_count" INTEGER NOT NULL DEFAULT 1
      )`,
    );
    const applied = await client.execute(
      'SELECT "migration_name", "checksum" FROM "_prisma_migrations"',
    );
    const appliedChecksums = new Map<string, string>();
    for (const row of applied.rows) {
      appliedChecksums.set(String(row.migration_name), String(row.checksum));
    }
    const newlyApplied: string[] = [];
    for (const name of names) {
      const sql = readFileSync(
        resolve(migrationsDir, name, "migration.sql"),
        "utf8",
      );
      const sum = checksum(sql);
      const previous = appliedChecksums.get(name);
      if (previous !== undefined) {
        if (previous !== sum) {
          throw new Error(
            `migration ${name} was already applied with a different checksum — refusing to continue`,
          );
        }
        continue;
      }
      const tx = await client.transaction("write");
      try {
        await tx.executeMultiple(sql);
        await tx.execute({
          sql: 'INSERT INTO "_prisma_migrations" ("id", "checksum", "migration_name", "applied_steps_count") VALUES (?, ?, ?, ?)',
          args: [`${Date.now()}_${name}`, sum, name, 1],
        });
        await tx.commit();
      } finally {
        tx.close();
      }
      newlyApplied.push(name);
    }
    return newlyApplied;
  } finally {
    client.close();
  }
}

// Process entry for boot (`RUN_MIGRATIONS`) and scripts: reads the
// environment, never a file. Fails fast naming the missing variable.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  // The env file lives next to the stack (server/.env), no matter which
  // directory the command was started from.
  loadEnvFile(resolve(here, "..", "..", ".."));
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("migrate: DATABASE_URL is required");
    process.exit(1);
  }
  console.log(`migrate: DATABASE_URL=${describeDatabaseUrl(url)}`);
  try {
    const applied = await applyMigrations({
      url,
      authToken: process.env.DATABASE_AUTH_TOKEN,
    });
    for (const name of applied) {
      console.log(`migrate: applied ${name}`);
    }
    console.log(
      applied.length === 0
        ? "migrate: database is up to date"
        : `migrate: applied ${applied.length} migration(s)`,
    );
  } catch (error) {
    console.error(
      `migrate: failed — ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
