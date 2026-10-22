import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "./generated/index.js";

/**
 * Builds the Prisma client for one database URL. The same code path
 * serves every environment: a local `file:` database for development
 * and tests, Turso Cloud (`libsql://` + auth token) in production.
 * One instance per process (server.ts) or per test database
 * (integration tests); repositories take it as a constructor argument.
 */
export function createDbClient(url: string, authToken?: string): PrismaClient {
  const adapter = new PrismaLibSql({ url, authToken });
  return new PrismaClient({ adapter });
}

export type DbClient = PrismaClient;
