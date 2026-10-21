import { DatabaseSync } from "node:sqlite";
import type { DbClient } from "../src/infra/prisma/client.js";
import { createSavedRepository } from "../src/infra/prisma/saved.js";
import { createSessionRepository } from "../src/infra/prisma/sessions.js";
import { createTemplateRepository } from "../src/infra/prisma/templates.js";
import { createUserRepository } from "../src/infra/prisma/users.js";

export interface ImportCounts {
	users: number;
	sessions: number;
	templates: number;
	published: number;
	saved: number;
	versions: number;
	userSyncs: number;
}

export interface ImportReport {
	dryRun: boolean;
	source: string;
	counts: ImportCounts;
}

interface LegacyUser {
	id: string;
	handle: string;
	password_hash: string;
	created_at: string;
}

interface LegacySession {
	token_hash: string;
	user_id: string;
	expires_at: string;
}

interface LegacyTemplate {
	id: string;
	owner_id: string;
	name: string;
	summary: string;
	page_w_mm: number;
	page_h_mm: number;
	language: string;
	body: string;
	readme: string;
	css: string;
	use_count: number;
	published_at: string;
	updated_at: string;
}

interface LegacySaved {
	user_id: string;
	template_id: string;
}

/**
 * One-off import from the Rust server's SQLite file (REFACTORING.md
 * section 7, E9). Reads every row, writes through the Prisma
 * repositories into PostgreSQL. Ids are kept verbatim, so every
 * remote_id stored in installed apps still resolves; scrypt password
 * hashes and session token hashes are stored untouched, so an old
 * password logs in (and rehashes to argon2id) and an old token still
 * authenticates. `published_at: ''` becomes null; naive
 * `YYYY-MM-DD HH:MM:SS` stamps are read as UTC.
 *
 * Run it on a copy first with --dry-run, which reads and validates
 * everything and prints row counts without writing a row.
 */
export async function importV1(options: {
	sqlitePath: string;
	db: DbClient;
	dryRun: boolean;
}): Promise<ImportReport> {
	let sqlite: DatabaseSync;
	try {
		sqlite = new DatabaseSync(options.sqlitePath, { readOnly: options.dryRun });
	} catch (error) {
		throw new Error(
			`Cannot open SQLite file ${options.sqlitePath} (node:sqlite needs Node 22.13+): ${String(error)}`,
		);
	}
	try {
		const users = sqlite.prepare("SELECT id, handle, password_hash, created_at FROM users").all() as unknown as LegacyUser[];
		const sessions = sqlite.prepare("SELECT token_hash, user_id, expires_at FROM sessions").all() as unknown as LegacySession[];
		const templates = sqlite.prepare("SELECT * FROM templates ORDER BY updated_at").all() as unknown as LegacyTemplate[];
		const saved = sqlite.prepare("SELECT user_id, template_id FROM saved_templates").all() as unknown as LegacySaved[];

		const userIds = new Set(users.map((u) => u.id));
		for (const session of sessions) {
			if (!userIds.has(session.user_id)) {
				throw new Error(`session ${session.token_hash.slice(0, 12)}… points at unknown user ${session.user_id}`);
			}
		}
		for (const template of templates) {
			if (!userIds.has(template.owner_id)) {
				throw new Error(`template ${template.id} points at unknown owner ${template.owner_id}`);
			}
		}

		const counts: ImportCounts = {
			users: users.length,
			sessions: sessions.length,
			templates: templates.length,
			published: templates.filter((t) => t.published_at !== "").length,
			saved: saved.length,
			versions: templates.length,
			userSyncs: users.length,
		};

		if (options.dryRun) {
			return { dryRun: true, source: options.sqlitePath, counts };
		}

		const usersRepo = createUserRepository(options.db);
		const sessionsRepo = createSessionRepository(options.db);
		const templatesRepo = createTemplateRepository(options.db);
		const savedRepo = createSavedRepository(options.db);

		await options.db.$transaction(async () => {
			for (const user of users) {
				await usersRepo.create({
					id: user.id,
					handle: user.handle,
					handleKey: user.handle.trim().toLowerCase(),
					passwordHash: user.password_hash,
				});
			}
			for (const session of sessions) {
				await sessionsRepo.create({
					tokenHash: session.token_hash,
					userId: session.user_id,
					expiresAt: parseDate(session.expires_at),
				});
			}
			for (const template of templates) {
				// v1 has no created_at column; updated_at is the best
				// available birth date for imported rows.
				const updatedAt = parseDate(template.updated_at);
				await templatesRepo.create(
					{
						id: template.id,
						ownerId: template.owner_id,
						name: template.name,
						summary: template.summary,
						pageWMm: template.page_w_mm,
						pageHMm: template.page_h_mm,
						language: template.language || "html",
						body: template.body,
						css: template.css,
						readme: template.readme,
						createdAt: updatedAt,
						updatedAt,
					},
					{ createdBy: "manual" },
				);
				if (template.published_at !== "") {
					await templatesRepo.setPublished(template.id, parseDate(template.published_at));
				}
				if (template.use_count !== 0) {
					await options.db.template.update({
						where: { id: template.id },
						data: { useCount: template.use_count },
					});
				}
			}
			for (const row of saved) {
				await savedRepo.save(row.user_id, row.template_id);
			}
		});

		return { dryRun: false, source: options.sqlitePath, counts };
	} finally {
		sqlite.close();
	}
}

/** v1 mixed naive `YYYY-MM-DD HH:MM:SS` (UTC, from datetime('now')) with
 * RFC 3339 (register responses). Naive stamps parse as UTC. */
function parseDate(raw: string): Date {
	if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) {
		return new Date(`${raw.replace(" ", "T")}Z`);
	}
	const parsed = new Date(raw);
	if (Number.isNaN(parsed.getTime())) {
		throw new Error(`unparseable timestamp: ${raw}`);
	}
	return parsed;
}

// CLI: pnpm import:v1 --source <sqlite-file> [--dry-run]. DATABASE_URL
// comes from the environment (the service's own variable).
if (import.meta.url === `file://${process.argv[1]}`) {
	const source = process.argv.includes("--source") ? process.argv[process.argv.indexOf("--source") + 1] : undefined;
	const dryRun = process.argv.includes("--dry-run");
	if (!source) {
		console.error("usage: import-v1 --source <sqlite-file> [--dry-run]");
		process.exit(2);
	}
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl && !dryRun) {
		console.error("DATABASE_URL is not set (not needed for --dry-run)");
		process.exit(2);
	}
	const { createDbClient } = await import("../src/infra/prisma/client.js");
	const db = dryRun ? (undefined as unknown as import("../src/infra/prisma/client.js").DbClient) : createDbClient(databaseUrl as string);
	try {
		const report = await importV1({ sqlitePath: source, db, dryRun });
		console.log(JSON.stringify(report, null, 2));
	} finally {
		if (!dryRun) {
			await db.$disconnect();
		}
	}
}
