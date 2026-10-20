import { describe, expect, it } from "vitest";
import {
	deleteTemplate,
	getTemplate,
	listCommunity,
	listMine,
	publishTemplate,
	recordUse,
	unpublishTemplate,
} from "../src/domain/templates/index.js";
import { putTemplate } from "../src/domain/templates/index.js";
import {
	listSaved,
	saveTemplate,
	unsaveTemplate,
} from "../src/domain/templates/index.js";
import {
	ForbiddenError,
	NotFoundError,
	RemoteReferenceError,
	PayloadTooLargeError,
	RevisionConflictError,
	RevisionRequiredError,
} from "../src/domain/errors.js";
import type {
	SavedRepository,
	TemplateRepository,
} from "../src/domain/templatePorts.js";
import { createFakeUsers } from "./fakes/index.js";
import { createFakeTemplateRepos } from "./fakes/templates.js";

const OWNER_ID = "owner-1";
const OTHER_ID = "other-1";

function repos(): {
	templates: TemplateRepository;
	saved: SavedRepository;
	store: ReturnType<typeof createFakeTemplateRepos>["store"];
} {
	const users = createFakeUsers();
	void users.create({
		id: OWNER_ID,
		handle: "Owner",
		handleKey: "owner",
		passwordHash: "x",
	});
	void users.create({
		id: OTHER_ID,
		handle: "Other",
		handleKey: "other",
		passwordHash: "x",
	});
	const { templates, saved, store } = createFakeTemplateRepos(users);
	return { templates, saved, store };
}

const write = (overrides: Record<string, unknown> = {}) => ({
	id: "11111111-1111-4111-8111-111111111111",
	name: "Label",
	summary: "",
	pageWMm: 101.6,
	pageHMm: 152.4,
	body: "<div>x</div>",
	...overrides,
});

describe("putTemplate", () => {
	it("creates private with revision 1, version 1 and the first sequence", async () => {
		const r = repos();
		const result = await putTemplate(r, write(), OWNER_ID);

		expect(result.status).toBe(201);
		expect(result.replayed).toBe(false);
		expect(result.template.revision).toBe(1);
		expect(result.template.versionCount).toBe(1);
		expect(result.template.changeSeq).toBe(2n);
		expect(result.template.publishedAt).toBeNull();
		expect(result.template.ownerHandle).toBe("Owner");
	});

	it("trims metadata, defaults language/css/readme and versions the label", async () => {
		const r = repos();
		const result = await putTemplate(
			r,
			write({ name: "  Padded  ", version: { createdBy: "manual", label: "v1" } }),
			OWNER_ID,
		);

		expect(result.template.name).toBe("Padded");
		expect(result.template.language).toBe("html");
		expect(result.template.css).toBe("");
	});

	it("updates with a matching revision, bumping revision, version and seq", async () => {
		const r = repos();
		const created = await putTemplate(r, write(), OWNER_ID);
		const result = await putTemplate(
			r,
			write({ body: "<div>y</div>", ifRevision: 1 }),
			OWNER_ID,
		);

		expect(result.status).toBe(200);
		expect(result.template.revision).toBe(2);
		expect(result.template.versionCount).toBe(2);
		expect(result.template.changeSeq).toBeGreaterThan(created.template.changeSeq);
	});

	it("keeps stored values for omitted fields and skips the version on metadata-only writes", async () => {
		const r = repos();
		await putTemplate(r, write({ summary: "S", css: ".a{}", readme: "R" }), OWNER_ID);
		const result = await putTemplate(
			r,
			{
				id: write().id as string,
				name: "Renamed",
				pageWMm: 101.6,
				pageHMm: 152.4,
				body: "<div>x</div>",
				ifRevision: 1,
			},
			OWNER_ID,
		);

		expect(result.template.revision).toBe(1);
		expect(result.template.versionCount).toBe(1);
		expect(result.template.summary).toBe("S");
		expect(result.template.css).toBe(".a{}");
		expect(result.template.readme).toBe("R");
		expect(result.template.name).toBe("Renamed");
	});

	it("requires if_revision on update and reports conflicts with the stored revision", async () => {
		const r = repos();
		await putTemplate(r, write(), OWNER_ID);

		await expect(putTemplate(r, write({ body: "<div>z</div>" }), OWNER_ID)).rejects.toBeInstanceOf(
			RevisionRequiredError,
		);
		const conflict = putTemplate(r, write({ body: "<div>z</div>", ifRevision: 99 }), OWNER_ID);
		await expect(conflict).rejects.toBeInstanceOf(RevisionConflictError);
		await expect(conflict).rejects.toMatchObject({ details: [{ path: "revision", message: "1" }] });
	});

	it("replays a stale revision with identical content without writing", async () => {
		const r = repos();
		await putTemplate(r, write(), OWNER_ID);
		const seqBefore = r.store.seqs.get(OWNER_ID);

		const result = await putTemplate(r, write({ ifRevision: 99 }), OWNER_ID);

		expect(result.status).toBe(200);
		expect(result.replayed).toBe(true);
		expect(result.template.revision).toBe(1);
		expect(r.store.seqs.get(OWNER_ID)).toBe(seqBefore);
		expect(r.store.templates.get(write().id as string)?.versions).toHaveLength(1);
	});

	it("refuses other owners and maps the owner create race to revision_required", async () => {
		const r = repos();
		await putTemplate(r, write(), OWNER_ID);

		await expect(putTemplate(r, write({ ifRevision: 1 }), OTHER_ID)).rejects.toBeInstanceOf(
			ForbiddenError,
		);
		// Same owner, duplicate id (a retried create racing the first):
		// the row now exists, so the caller retries as an update.
		await expect(putTemplate(r, write(), OWNER_ID)).rejects.toBeInstanceOf(
			RevisionRequiredError,
		);
	});

	it("rejects remote references and over-cap fields", async () => {
		const r = repos();
		const remote = putTemplate(
			r,
			write({ body: '<img src="http://x/y.png">' }),
			OWNER_ID,
		);
		await expect(remote).rejects.toBeInstanceOf(RemoteReferenceError);

		const big = putTemplate(r, write({ body: "a".repeat(512 * 1024 + 1) }), OWNER_ID);
		await expect(big).rejects.toBeInstanceOf(PayloadTooLargeError);
	});
});

describe("visibility and ownership", () => {
	it("hides private templates from everyone but the owner", async () => {
		const r = repos();
		await putTemplate(r, write(), OWNER_ID);

		await expect(getTemplate(r, write().id as string, null)).rejects.toBeInstanceOf(NotFoundError);
		await expect(getTemplate(r, write().id as string, OTHER_ID)).rejects.toBeInstanceOf(NotFoundError);
		const own = await getTemplate(r, write().id as string, OWNER_ID);
		expect(own.body).toBe("<div>x</div>");
	});

	it("publishes keeping the first time, and unpublishing hides again", async () => {
		const r = repos();
		const deps = { templates: r.templates };
		await putTemplate(r, write(), OWNER_ID);

		const first = await publishTemplate(deps, write().id as string, OWNER_ID, new Date("2026-10-21T00:00:00Z"));
		expect(first.publishedAt?.toISOString()).toBe("2026-10-21T00:00:00.000Z");
		const again = await publishTemplate(deps, write().id as string, OWNER_ID, new Date("2027-01-01T00:00:00Z"));
		expect(again.publishedAt?.toISOString()).toBe("2026-10-21T00:00:00.000Z");

		const anon = await getTemplate(r, write().id as string, null);
		expect(anon.publishedAt).not.toBeNull();

		await unpublishTemplate(deps, write().id as string, OWNER_ID);
		await expect(getTemplate(r, write().id as string, null)).rejects.toBeInstanceOf(NotFoundError);

		// Republishing after an unpublish restores the original time.
		const restored = await publishTemplate(deps, write().id as string, OWNER_ID, new Date("2028-01-01T00:00:00Z"));
		expect(restored.publishedAt?.toISOString()).toBe("2026-10-21T00:00:00.000Z");
	});

	it("deletes write a tombstone and forbid other owners", async () => {
		const r = repos();
		const deps = { templates: r.templates };
		await putTemplate(r, write(), OWNER_ID);

		await expect(deleteTemplate(deps, write().id as string, OTHER_ID)).rejects.toBeInstanceOf(ForbiddenError);
		await deleteTemplate(deps, write().id as string, OWNER_ID);
		expect(r.store.tombstones).toHaveLength(1);
		expect(r.store.tombstones[0]).toMatchObject({
			userId: OWNER_ID,
			entity: "template",
			entityKey: write().id,
		});
		await expect(getTemplate(r, write().id as string, OWNER_ID)).rejects.toBeInstanceOf(NotFoundError);
	});
});

describe("lists, search and use", () => {
	async function seeded() {
		const r = repos();
		const deps = { templates: r.templates };
		const a = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
		const b = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
		await putTemplate(r, { ...write(), id: a, name: "Alpha label" }, OWNER_ID);
		await putTemplate(r, { ...write(), id: b, name: "beta 100% cotton" }, OWNER_ID);
		await publishTemplate(deps, b, OWNER_ID, new Date("2026-10-21T00:00:00Z"));
		return { r, a, b };
	}

	it("mine returns only the owner's, newest first", async () => {
		const { r } = await seeded();
		const mine = await listMine({ templates: r.templates }, OWNER_ID, { page: 1, pageSize: 20 });
		expect(mine.items.map((t) => t.name)).toEqual(["beta 100% cotton", "Alpha label"]);
		expect(mine.total).toBe(2);

		const other = await listMine({ templates: r.templates }, OTHER_ID, { page: 1, pageSize: 20 });
		expect(other.items).toEqual([]);
	});

	it("community shows published only, finds owner handle and literal %", async () => {
		const { r, b } = await seeded();
		const all = await listCommunity({ templates: r.templates }, { page: 1, pageSize: 20, sort: "updated" });
		expect(all.items.map((t) => t.id)).toEqual([b]);

		const byHandle = await listCommunity(
			{ templates: r.templates },
			{ page: 1, pageSize: 20, sort: "updated", q: "own" },
		);
		expect(byHandle.items.map((t) => t.id)).toEqual([b]);

		const literal = await listCommunity(
			{ templates: r.templates },
			{ page: 1, pageSize: 20, sort: "updated", q: "100%" },
		);
		expect(literal.items.map((t) => t.id)).toEqual([b]);
	});

	it("paginates with total and has_more", async () => {
		const { r } = await seeded();
		const deps = { templates: r.templates };
		await publishTemplate(deps, "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", OWNER_ID, new Date());

		const first = await listCommunity(deps, { page: 1, pageSize: 1, sort: "updated" });
		expect(first.total).toBe(2);
		expect(first.has_more).toBe(true);
		expect(first.items).toHaveLength(1);
		const second = await listCommunity(deps, { page: 2, pageSize: 1, sort: "updated" });
		expect(second.has_more).toBe(false);
		expect(second.items).toHaveLength(1);
		expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
	});

	it("counts uses only for published templates", async () => {
		const { r, a, b } = await seeded();
		const deps = { templates: r.templates };
		await recordUse(deps, b, 3);
		const got = await getTemplate(r, b, null);
		expect(got.useCount).toBe(3);

		await expect(recordUse(deps, a, 1)).rejects.toBeInstanceOf(NotFoundError);
		await expect(recordUse(deps, "99999999-9999-4999-8999-999999999999", 1)).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});
});

describe("saved", () => {
	it("saves published, repeats idempotently, lists newest first and unsaves", async () => {
		const r = repos();
		const tdeps = { templates: r.templates };
		const sdeps = { templates: r.templates, saved: r.saved };
		const id = write().id as string;
		await putTemplate(r, write(), OWNER_ID);

		await expect(saveTemplate(sdeps, OTHER_ID, id)).rejects.toBeInstanceOf(NotFoundError);
		await publishTemplate(tdeps, id, OWNER_ID, new Date());
		await saveTemplate(sdeps, OTHER_ID, id);
		await saveTemplate(sdeps, OTHER_ID, id);
		expect(await r.saved.countByUser(OTHER_ID)).toBe(1);

		const listed = await listSaved({ saved: r.saved }, OTHER_ID, { page: 1, pageSize: 20 });
		expect(listed.items.map((t) => t.id)).toEqual([id]);

		await unsaveTemplate({ saved: r.saved }, OTHER_ID, id);
		await unsaveTemplate({ saved: r.saved }, OTHER_ID, id);
		expect(await r.saved.countByUser(OTHER_ID)).toBe(0);
	});

	it("unpublishing hides saved rows without deleting them", async () => {
		const r = repos();
		const tdeps = { templates: r.templates };
		const sdeps = { templates: r.templates, saved: r.saved };
		const id = write().id as string;
		await putTemplate(r, write(), OWNER_ID);
		await publishTemplate(tdeps, id, OWNER_ID, new Date());
		await saveTemplate(sdeps, OTHER_ID, id);

		await unpublishTemplate(tdeps, id, OWNER_ID);
		const listed = await listSaved({ saved: r.saved }, OTHER_ID, { page: 1, pageSize: 20 });
		expect(listed.items).toEqual([]);

		await publishTemplate(tdeps, id, OWNER_ID, new Date());
		const back = await listSaved({ saved: r.saved }, OTHER_ID, { page: 1, pageSize: 20 });
		expect(back.items.map((t) => t.id)).toEqual([id]);
	});
});
