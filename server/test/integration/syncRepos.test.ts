import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSyncRepository } from "../../src/infra/prisma/sync.js";
import type { SyncRepository } from "../../src/domain/syncPorts.js";
import type { TemplateRepository } from "../../src/domain/templatePorts.js";
import { createTemplateRepository } from "../../src/infra/prisma/templates.js";
import { createFakeUsers } from "../fakes/index.js";
import { createFakeTemplateRepos } from "../fakes/templates.js";
import { startTestDatabase, truncateAll, type TestStack } from "./db.js";

// Sync repository contract (REFACTORING.md section 7): the same
// behaviors run twice, against the in-memory fakes and PostgreSQL. The
// per-user row lock is what makes cursors gap-free; the concurrency
// test below is the small durable version of the Phase 1 spike proof.

interface Backend {
	sync: SyncRepository;
	templates: TemplateRepository;
	createUser(handle: string): Promise<string>;
	createTemplate(ownerId: string, name: string): Promise<{ id: string; seq: bigint }>;
}

const write = (id: string, ownerId: string, name: string) => ({
	id,
	ownerId,
	name,
	summary: "",
	pageWMm: 101.6,
	pageHMm: 152.4,
	language: "html",
	body: `<div>${name}</div>`,
	css: "",
	readme: "",
});
const version = { createdBy: "manual" as const };

let stack: TestStack;

beforeAll(async () => {
	stack = await startTestDatabase();
}, 180_000);

afterAll(async () => {
	await stack?.stop();
});

beforeEach(async () => {
	await truncateAll(stack.db);
});

function fakeBackend(): Backend {
	const users = createFakeUsers();
	const repos = createFakeTemplateRepos(users);
	return {
		sync: repos.sync,
		templates: repos.templates,
		createUser: async (handle: string) => {
			const id = randomUUID();
			await users.create({ id, handle, handleKey: handle.toLowerCase(), passwordHash: "x" });
			return id;
		},
		createTemplate: async (ownerId: string, name: string) => {
			const id = randomUUID();
			const created = await repos.templates.create(write(id, ownerId, name), version);
			return { id, seq: created.changeSeq };
		},
	};
}

function prismaBackend(): Backend {
	const db = stack.db;
	const templates = createTemplateRepository(db);
	return {
		sync: createSyncRepository(db),
		templates,
		createUser: async (handle: string) => {
			const user = await db.user.create({
				data: { id: randomUUID(), handle, handleKey: handle.toLowerCase(), passwordHash: "x" },
			});
			return user.id;
		},
		createTemplate: async (ownerId: string, name: string) => {
			const id = randomUUID();
			const created = await templates.create(write(id, ownerId, name), version);
			return { id, seq: created.changeSeq };
		},
	};
}

for (const name of ["fake", "prisma"] as const) {
	describe(`on ${name}`, () => {
		let be: Backend;
		let owner: string;

		beforeEach(async () => {
			be = name === "fake" ? fakeBackend() : prismaBackend();
			owner = await be.createUser(`sync-owner-${randomUUID().slice(0, 8)}`);
		});

		it("starts empty with floor zero and cursor zero", async () => {
			expect(await be.sync.tombstoneFloor(owner)).toBe(0n);
			const page = await be.sync.readSince(owner, { cursor: 0n, limit: 100, types: ["template"] }, 8 * 1024 * 1024);
			expect(page.changes).toEqual([]);
			expect(page.nextCursor).toBe(0n);
			expect(page.hasMore).toBe(false);
		});

		it("returns upserts in sequence order with head versions", async () => {
			const a = await be.createTemplate(owner, "a");
			const b = await be.createTemplate(owner, "b");

			const page = await be.sync.readSince(owner, { cursor: 0n, limit: 100, types: ["template"] }, 8 * 1024 * 1024);
			expect(page.changes.map((c) => c.seq)).toEqual([a.seq, b.seq]);
			expect(page.hasMore).toBe(false);
			expect(page.nextCursor).toBe(b.seq);
			const first = page.changes[0];
			expect(first && "data" in first && first.data.name).toBe("a");
			expect(first && "data" in first && first.headVersionNo).toBe(1);

			const second = await be.templates.update(
				{ ...(await be.templates.findById(b.id))!, body: "<div>b2</div>" },
				1,
				version,
			);
			expect(second.revision).toBe(2);
			const since = await be.sync.readSince(owner, { cursor: a.seq, limit: 100, types: ["template"] }, 8 * 1024 * 1024);
			expect(since.changes.map((c) => c.seq)).toEqual([second.changeSeq]);
		});

		it("reports deletes as delete records and moves the floor", async () => {
			const a = await be.createTemplate(owner, "a");
			await be.createTemplate(owner, "b");
			await be.templates.deleteWithTombstone(a.id);

			const page = await be.sync.readSince(owner, { cursor: 0n, limit: 100, types: ["template"] }, 8 * 1024 * 1024);
			const kinds = page.changes.map((c) => ("data" in c ? `upsert:${c.data.name}` : `delete:${c.entityKey}`));
			expect(kinds).toContain(`delete:${a.id}`);
			expect(kinds).toContain("upsert:b");

			// Deletes sort by their own sequence, after the creates.
		 const seqs = page.changes.map((c) => c.seq);
			expect([...seqs].sort((x, y) => (x < y ? -1 : 1))).toEqual(seqs);

			expect(await be.sync.tombstoneFloor(owner)).toBeGreaterThan(0n);
		});

		it("paginates by count with has_more and next_cursor", async () => {
			for (let i = 0; i < 5; i += 1) {
				await be.createTemplate(owner, `t${i}`);
			}
			const first = await be.sync.readSince(owner, { cursor: 0n, limit: 2, types: ["template"] }, 8 * 1024 * 1024);
			expect(first.changes).toHaveLength(2);
			expect(first.hasMore).toBe(true);

			const second = await be.sync.readSince(owner, { cursor: first.nextCursor, limit: 2, types: ["template"] }, 8 * 1024 * 1024);
			expect(second.changes).toHaveLength(2);
			expect(second.hasMore).toBe(true);

			const third = await be.sync.readSince(owner, { cursor: second.nextCursor, limit: 2, types: ["template"] }, 8 * 1024 * 1024);
			expect(third.changes).toHaveLength(1);
			expect(third.hasMore).toBe(false);
		});

		it("stops at the byte budget with has_more set", async () => {
			await be.createTemplate(owner, "big-one");
			await be.createTemplate(owner, "big-two");

			// Budget fits the first change but not the second.
			const page = await be.sync.readSince(owner, { cursor: 0n, limit: 100, types: ["template"] }, 700);
			expect(page.changes).toHaveLength(1);
			expect(page.hasMore).toBe(true);

			const rest = await be.sync.readSince(owner, { cursor: page.nextCursor, limit: 100, types: ["template"] }, 8 * 1024 * 1024);
			expect(rest.changes).toHaveLength(1);
			expect(rest.hasMore).toBe(false);
		});

		it("filters by types", async () => {
			await be.createTemplate(owner, "a");
			const page = await be.sync.readSince(owner, { cursor: 0n, limit: 100, types: ["dataset", "font"] }, 8 * 1024 * 1024);
			expect(page.changes).toEqual([]);
			expect(page.hasMore).toBe(false);
		});

		it("purges only tombstones past the cutoff", async () => {
			const a = await be.createTemplate(owner, "a");
			await be.templates.deleteWithTombstone(a.id);

			expect(await be.sync.purgeTombstones(new Date("2000-01-01T00:00:00Z"))).toBe(0);
			expect(await be.sync.tombstoneFloor(owner)).toBeGreaterThan(0n);
			expect(await be.sync.purgeTombstones(new Date("2999-01-01T00:00:00Z"))).toBe(1);
			expect(await be.sync.tombstoneFloor(owner)).toBe(0n);
		});

		it("keeps one user's concurrent writes gap-free while another writes too", async () => {
			const other = await be.createUser(`sync-other-${randomUUID().slice(0, 8)}`);
			const seen = new Set<string>();

			const writers = Array.from({ length: 5 }, (_, w) =>
				(async () => {
					for (let i = 0; i < 10; i += 1) {
						const id = randomUUID();
						const created = await be.templates.create(write(id, owner, `w${w}-${i}`), version);
						seen.add(`${created.changeSeq}`);
					}
				})(),
			);
			const otherWriter = (async () => {
				for (let i = 0; i < 10; i += 1) {
					await be.templates.create(write(randomUUID(), other, `o-${i}`), version);
				}
			})();
			// A reader polls throughout; every sequence it sees is new.
			const reader = (async () => {
				let cursor = 0n;
				for (let i = 0; i < 30; i += 1) {
					const page = await be.sync.readSince(owner, { cursor, limit: 25, types: ["template"] }, 8 * 1024 * 1024);
					for (const change of page.changes) {
						if (change.seq <= cursor) {
							throw new Error(`reader went backwards: ${change.seq} after ${cursor}`);
						}
						cursor = change.seq;
					}
					if (!page.hasMore) {
						await new Promise((r) => setTimeout(r, 5));
					}
				}
			})();
			await Promise.all([...writers, otherWriter, reader]);

			// The full pass afterwards holds every record exactly once, in
			// consecutive sequence order — no gaps, no skips.
			const full = await be.sync.readSince(owner, { cursor: 0n, limit: 100, types: ["template"] }, 32 * 1024 * 1024);
			expect(full.changes).toHaveLength(50);
			const seqs = full.changes.map((c) => c.seq);
			for (let i = 1; i < seqs.length; i += 1) {
				expect(seqs[i]).toBe(seqs[i - 1] + 1n);
			}
			expect(new Set(seqs.map(String)).size).toBe(50);
			expect(seen.size).toBe(50);
		});
	});
}
