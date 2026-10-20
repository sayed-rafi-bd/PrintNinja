import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client.js";

/**
 * Builds the Prisma client for one database URL. One instance per
 * process (server.ts) or per test container (integration tests);
 * repositories take it as a constructor argument.
 */
export function createDbClient(url: string): PrismaClient {
	const adapter = new PrismaPg({ connectionString: url });
	return new PrismaClient({ adapter });
}

export type DbClient = PrismaClient;
