import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { loadEnvFile } from "../src/config.js";
import { describeDatabaseUrl } from "../src/infra/db/describe-url.js";
import { applyMigrations } from "../src/infra/db/migrate.js";

// Drops every user table, then re-applies the migrations from
// prisma/migrations/ — the database ends up byte-identical to a fresh
// `db:apply` on an empty file. Works for `file:` URLs (local dev) and
// `libsql:` URLs (Turso) through the same client.
//
// Destructive on purpose: refuses to run without `--force`, so a bare
// `pnpm db:reset` only reports what would be dropped. Never wire this
// into boot, CI, or a workflow — it is a manual recovery tool.

const here = fileURLToPath(new URL(".", import.meta.url));

async function listUserTables(
  url: string,
  authToken: string | undefined,
): Promise<string[]> {
  const client = createClient({ url, authToken });
  try {
    const result = await client.execute(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    return result.rows.map((row) => String(row.name));
  } finally {
    client.close();
  }
}

async function dropTables(
  url: string,
  authToken: string | undefined,
  tables: string[],
): Promise<void> {
  const client = createClient({ url, authToken });
  try {
    // Best effort: dropping tables does not need FK enforcement off in
    // SQLite, but disabling it keeps legacy databases quiet. Remote
    // endpoints that reject the pragma still drop fine.
    await client.execute(`PRAGMA foreign_keys = OFF`).catch(() => {});
    for (const table of tables) {
      await client.execute(`DROP TABLE IF EXISTS "${table.replace(/"/g, '""')}"`);
    }
  } finally {
    client.close();
  }
}

async function main(): Promise<void> {
  // The env file lives next to the stack (server/.env), no matter which
  // directory the command was started from.
  loadEnvFile(resolve(here, ".."));
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("db:reset: DATABASE_URL is required");
    process.exit(1);
  }
  const authToken = process.env.DATABASE_AUTH_TOKEN;
  const force = process.argv.includes("--force");

  console.log(`db:reset: DATABASE_URL=${describeDatabaseUrl(url)}`);
  const tables = await listUserTables(url, authToken);
  if (tables.length === 0) {
    console.log("db:reset: no user tables — nothing to drop");
  } else if (!force) {
    console.error(
      `db:reset: refusing to drop ${tables.length} table(s) without --force: ${tables.join(", ")}`,
    );
    console.error("db:reset: re-run with `pnpm db:reset --force` to wipe and rebuild");
    process.exit(1);
  } else {
    await dropTables(url, authToken, tables);
    console.log(`db:reset: dropped ${tables.length} table(s)`);
  }

  const applied = await applyMigrations({ url, authToken });
  for (const name of applied) {
    console.log(`db:reset: applied ${name}`);
  }
  console.log("db:reset: database is clean and up to date");
}

await main().catch((error: unknown) => {
  console.error(
    `db:reset: failed — ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
