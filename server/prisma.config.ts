import { defineConfig, env } from "prisma/config";

// Prisma 7 entry point (REFACTORING.md section 12). The schema file
// carries no connection string; it lives here, read from the
// environment, and fails fast naming the variable when it is missing.
// In development pass --env-file; the service itself never auto-loads.
export default defineConfig({
	schema: "prisma/schema.prisma",
	migrations: {
		path: "prisma/migrations",
	},
	datasource: {
		url: env("DATABASE_URL"),
	},
});
