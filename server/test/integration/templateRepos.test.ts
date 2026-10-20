import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	RevisionConflictError,
	RevisionRequiredError,
} from "../../src/domain/errors.js";
import type {
	SavedRepository,
	TemplateRepository,
} from "../../src/domain/templatePorts.js";
import { createSavedRepository } from "../../src/infra/prisma/saved.js";
import { createTemplateRepository } from "../../src/infra/prisma/templates.js";
import { createFakeUsers } from "../fakes/index.js";
import { createFakeTemplateRepos } from "../fakes/templates.js";
import { realDeps, startTestDatabase, truncateAll, type TestStack } from "./db.js";

// Repository contract suite (REFACTORING.md section 11): the same
// behaviors run twice, once against the in-memory fakes and once against
// PostgreSQL. If a fake ever disagrees with the database, a test fails,
// so the domain unit tests cannot pass on behaviour the real store does
// not have. Ordering ties are exercised through the name sort (two rows
// with one name); updated_at ties share the same id-asc tail.

interface Backend {
	templates: TemplateRepository;
	saved: SavedRepository;
	createUser(handle: string): Promise<string>;
	lastSeq(userId: string): Promise<bigint>;
	tombstones(userId: string): Promise<{ seq: bigint; entityKey: string }[]>;
	versionCount(templateId: string): Promise<number>;
}

void realDeps;

const write = (id: string, ownerId: string, overrides: Record<string, unknown> = {}) => ({
	id,
	ownerId,
	name: "Label",
	summary: "",
	pageWMm: 101.6,
	pageHMm: 152.4,
	language: "html",
	body: "<div>x</div>",
	css: "",
	readme: "",
	...overrides,
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
		templates: repos.templates,
		saved: repos.saved,
		createUser: async (handle: string) => {
			const id = randomUUID();
			await users.create({ id, handle, handleKey: handle.toLowerCase(), passwordHash: "x" });
			return id;
		},
		lastSeq: async (userId: string) => repos.store.seqs.get(userId) ?? 1n,
		tombstones: async (userId: string) =>
			repos.store.tombstones
				.filter((t) => t.userId === userId)
				.map((t) => ({ seq: t.seq, entityKey: t.entityKey })),
		versionCount: async (templateId: string) =>
			repos.store.templates.get(templateId)?.versions.length ?? 0,
	};
}

function prismaBackend(): Backend {
	const db = stack.db;
	return {
		templates: createTemplateRepository(db),
		saved: createSavedRepository(db),
		createUser: async (handle: string) => {
			const user = await db.user.create({
				data: {
					id: randomUUID(),
					handle,
					handleKey: handle.toLowerCase(),
					passwordHash: "x",
				},
			});
			return user.id;
		},
		lastSeq: async (userId: string) =>
			(await db.userSync.findUnique({ where: { userId } }))?.nextSeq ?? 1n,
		tombstones: async (userId: string) =>
			(await db.tombstone.findMany({ where: { userId }, orderBy: { seq: "asc" } })).map(
				(t) => ({ seq: t.seq, entityKey: t.entityKey }),
			),
		versionCount: async (templateId: string) =>
			db.templateVersion.count({ where: { templateId } }),
	};
}

for (const name of ["fake", "prisma"] as const) {
	describe(`on ${name}`, () => {
		let be: Backend;
		let owner: string;
		let other: string;

		beforeEach(async () => {
			be = name === "fake" ? fakeBackend() : prismaBackend();
			owner = await be.createUser(`Owner-${randomUUID().slice(0, 8)}`);
			other = await be.createUser(`Other-${randomUUID().slice(0, 8)}`);
		});

		it("creates with revision 1, version 1 and the first sequence 2n", async () => {
			const id = randomUUID();
			const created = await be.templates.create(write(id, owner), version);

			expect(created.revision).toBe(1);
			expect(created.publishedAt).toBeNull();
			expect(await be.versionCount(id)).toBe(1);
			expect(await be.lastSeq(owner)).toBe(2n);
			expect(created.changeSeq).toBe(2n);
		});

		it("maps a duplicate id to revision_required", async () => {
			const id = randomUUID();
			await be.templates.create(write(id, owner), version);

			await expect(be.templates.create(write(id, owner), version)).rejects.toBeInstanceOf(
				RevisionRequiredError,
			);
		});

		it("updates bump revision, version and sequence; metadata-only skips revision and version", async () => {
			const id = randomUUID();
			await be.templates.create(write(id, owner), version);

			const updated = await be.templates.update(
				{ ...write(id, owner), body: "<div>y</div>" },
				1,
				version,
			);
			expect(updated.revision).toBe(2);
			expect(await be.versionCount(id)).toBe(2);
			const seqAfterContent = (await be.templates.findById(id))?.changeSeq;
			expect(seqAfterContent).toBeGreaterThan(2n);

			const meta = await be.templates.update(
				{ ...write(id, owner, { body: "<div>y</div>", name: "Renamed" }) },
				2,
				null,
			);
			expect(meta.revision).toBe(2);
			expect(meta.name).toBe("Renamed");
			expect(await be.versionCount(id)).toBe(2);
			expect(meta.changeSeq).toBeGreaterThan(seqAfterContent ?? 0n);
		});

		it("rejects stale revisions with the stored one", async () => {
			const id = randomUUID();
			await be.templates.create(write(id, owner), version);
			await be.templates.update({ ...write(id, owner), body: "<div>y</div>" }, 1, version);

			const stale = be.templates.update({ ...write(id, owner), body: "<div>z</div>" }, 1, version);
			await expect(stale).rejects.toBeInstanceOf(RevisionConflictError);
			await expect(stale).rejects.toMatchObject({ details: [{ path: "revision", message: "2" }] });
		});

		it("publishes keeping the first time, then unpublishes", async () => {
			const id = randomUUID();
			await be.templates.create(write(id, owner), version);

			const first = await be.templates.setPublished(id, new Date("2026-10-21T00:00:00Z"));
			expect(first?.publishedAt?.toISOString()).toBe("2026-10-21T00:00:00.000Z");
			// The repository sets what it is given; keeping the first
			// publish time on repeats is the domain's job (covered in
			// template-domain.test.ts). A repeat still takes a sequence.
			const again = await be.templates.setPublished(id, new Date("2026-10-21T00:00:00Z"));
			expect(again?.publishedAt?.toISOString()).toBe("2026-10-21T00:00:00.000Z");

			const seqAfterPublish = (await be.templates.findById(id))?.changeSeq;
			await be.templates.setPublished(id, null);
			expect((await be.templates.findById(id))?.publishedAt).toBeNull();
			expect((await be.templates.findById(id))?.changeSeq).toBeGreaterThan(seqAfterPublish ?? 0n);
			expect(await be.templates.setPublished(randomUUID(), new Date())).toBeNull();

			// Unpublish never clears the memory: republishing restores the
			// original time instead of minting a new one.
			const republished = await be.templates.setPublished(id, new Date("2027-05-05T00:00:00Z"));
			expect(republished?.publishedAt?.toISOString()).toBe("2026-10-21T00:00:00.000Z");
		});

		it("deletes write a tombstone and remove versions and saves", async () => {
			const id = randomUUID();
			await be.templates.create(write(id, owner), version);
			await be.templates.setPublished(id, new Date());
			await be.saved.save(other, id);

			const deleted = await be.templates.deleteWithTombstone(id);
			expect(deleted).toEqual({ ownerId: owner });
			expect(await be.templates.findById(id)).toBeNull();
			expect(await be.versionCount(id)).toBe(0);
			expect(await be.saved.countByUser(other)).toBe(0);

			const tombs = await be.tombstones(owner);
			expect(tombs).toHaveLength(1);
			expect(tombs[0]?.entityKey).toBe(id);
			expect(await be.templates.deleteWithTombstone(id)).toBeNull();
		});

		it("lists the owner's newest first with total and has_more", async () => {
			const a = randomUUID();
			const b = randomUUID();
			await be.templates.create(write(a, owner, { name: "First" }), version);
			await be.templates.create(write(b, owner, { name: "Second" }), version);
			await be.templates.create(write(randomUUID(), other), version);

			const mine = await be.templates.listByOwner(owner, { page: 1, pageSize: 20 });
			expect(mine.items.map((t) => t.name)).toEqual(["Second", "First"]);
			expect(mine.total).toBe(2);

			const page = await be.templates.listByOwner(owner, { page: 2, pageSize: 1 });
			expect(page.items).toHaveLength(1);
			expect(page.has_more).toBe(false);
			expect(page.total).toBe(2);
		});

		it("searches name, summary and owner handle literally, published only", async () => {
			const pub = randomUUID();
			const priv = randomUUID();
			await be.templates.create(write(pub, owner, { name: "100% cotton", summary: "soft" }), version);
			await be.templates.create(write(priv, owner, { name: "Hidden" }), version);
			await be.templates.setPublished(pub, new Date());

			const all = await be.templates.listPublished({ page: 1, pageSize: 20, sort: "updated" });
			expect(all.items.map((t) => t.id)).toEqual([pub]);

			const handle = await be.createUser(`Zed-${randomUUID().slice(0, 8)}`);
			const otherPub = randomUUID();
			await be.templates.create(write(otherPub, handle, { name: "Plain" }), version);
			await be.templates.setPublished(otherPub, new Date());

			for (const q of ["100%", "soft", "zed"]) {
				const found = await be.templates.listPublished({ page: 1, pageSize: 20, sort: "updated", q });
				expect(found.items.map((t) => t.id), `q=${q}`).toContain(q === "zed" ? otherPub : pub);
			}
		});

		it("sorts used and name with id tie-breaks", async () => {
			const a = randomUUID();
			const b = randomUUID();
			await be.templates.create(write(a, owner, { name: "Same" }), version);
			await be.templates.create(write(b, owner, { name: "Same" }), version);
			await be.templates.setPublished(a, new Date());
			await be.templates.setPublished(b, new Date());
			await be.templates.incrementUseCount(b, 2);
			await be.templates.incrementUseCount(a, 1);

			const used = await be.templates.listPublished({ page: 1, pageSize: 20, sort: "used" });
			expect(used.items.map((t) => t.id)).toEqual([b, a]);

			const named = await be.templates.listPublished({ page: 1, pageSize: 20, sort: "name" });
			expect(named.items.map((t) => t.id)).toEqual(a < b ? [a, b] : [b, a]);
		});

		it("counts uses for published templates only", async () => {
			const pub = randomUUID();
			const priv = randomUUID();
			await be.templates.create(write(pub, owner), version);
			await be.templates.create(write(priv, owner), version);
			await be.templates.setPublished(pub, new Date());

			expect(await be.templates.incrementUseCount(pub, 50)).toBe(true);
			expect(await be.templates.incrementUseCount(priv, 1)).toBe(false);
			expect(await be.templates.incrementUseCount(randomUUID(), 1)).toBe(false);
			expect((await be.templates.findById(pub))?.useCount).toBe(50);
		});

		it("saves idempotently, lists newest first without the unpublished", async () => {
			const one = randomUUID();
			const two = randomUUID();
			await be.templates.create(write(one, owner), version);
			await be.templates.create(write(two, owner), version);
			await be.templates.setPublished(one, new Date());
			await be.templates.setPublished(two, new Date());

			await be.saved.save(other, one);
			await be.saved.save(other, two);
			await be.saved.save(other, one);
			expect(await be.saved.countByUser(other)).toBe(2);

			const listed = await be.saved.list(other, { page: 1, pageSize: 20 });
			expect(listed.items.map((t) => t.id)).toEqual([two, one]);

			await be.templates.setPublished(one, null);
			const afterUnpublish = await be.saved.list(other, { page: 1, pageSize: 20 });
			expect(afterUnpublish.items.map((t) => t.id)).toEqual([two]);

			await be.saved.unsave(other, two);
			await be.saved.unsave(other, two);
			expect(await be.saved.countByUser(other)).toBe(1);
		});
	});
}
