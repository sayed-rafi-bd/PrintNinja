import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaLibSql as PrismaLibSqlWeb } from "@prisma/adapter-libsql/web";
import { PrismaClient } from "./generated/index.js";

/**
 * Builds the Prisma client for one database URL. The same code path
 * serves every environment: a local `file:` database for development
 * and tests, Turso Cloud (`libsql://` + auth token) in production.
 * One instance per process (server.ts), per test database
 * (integration tests) or per serverless cold start (api/index.ts);
 * repositories take it as a constructor argument.
 *
 * Remote URLs go through the fetch-only web client and driver adapter,
 * so serverless runtimes never touch the native SQLite binding (which
 * is only needed — and only loaded — for local `file:` databases).
 */
export function createDbClient(url: string, authToken?: string): PrismaClient {
  const adapter =
    url.startsWith("libsql:") || url.startsWith("https:")
      ? new PrismaLibSqlWeb({ url, authToken })
      : new PrismaLibSql({ url, authToken });
  return new PrismaClient({ adapter });
}

export type DbClient = PrismaClient;
