import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { testConfig } from "../helpers.js";
import { realDeps, startTestDatabase, truncateAll, type TestStack } from "./db.js";

// Merged sync stream over the Phase 4 library (PostgreSQL only — the
// in-memory fake sync serves templates, see test/fakes/templates.ts).
// One user's writes share the user_sync sequence across all five tables,
// so a single cursor walks templates, datasets, profiles, settings and
// fonts in commit order, with deletes as tombstones and types filtering
// what comes back.

let stack: TestStack;
let app: FastifyInstance;

beforeAll(async () => {
	stack = await startTestDatabase();
}, 180_000);

afterAll(async () => {
	await stack?.stop();
});

beforeEach(async () => {
	await truncateAll(stack.db);
	app = await buildApp({ config: testConfig(), deps: realDeps(stack.db) });
});

afterEach(async () => {
	await app?.close();
});

const version = { createdBy: "manual" as const };
const ALL = ["template", "dataset", "profile", "setting", "font"] as const;

describe("merged library sync stream", () => {
	it("walks all five entities in sequence order with deletes as tombstones", async () => {
		const deps = realDeps(stack.db);
		const userId = randomUUID();
		await stack.db.user.create({
			data: { id: userId, handle: "Merge", handleKey: "merge", passwordHash: "x" },
		});

		const templateId = randomUUID();
		await deps.templates.create(
			{
				id: templateId,
				ownerId: userId,
				name: "T",
				summary: "",
				pageWMm: 101.6,
				pageHMm: 152.4,
				language: "html",
				body: "<div>t</div>",
				css: "",
				readme: "",
			},
			version,
		);
		const datasetId = randomUUID();
		await deps.datasets.create({ id: datasetId, ownerId: userId, name: "D", dataJson: '{"rows":[]}' });
		const profileId = randomUUID();
		await deps.profiles.create({
			id: profileId,
			ownerId: userId,
			templateId,
			printerName: "e2e label printer",
			settingsJson: "{}",
		});
		await deps.settings.create({ ownerId: userId, key: "ui_density", value: "compact" });
		const fontId = randomUUID();
		await deps.fonts.create({ id: fontId, ownerId: userId, name: "Body" });

		const page = await deps.sync.readSince(
			userId,
			{ cursor: 0n, limit: 100, types: [...ALL] },
			8 * 1024 * 1024,
		);
		expect(page.hasMore).toBe(false);
		expect(page.changes.map((c) => ("entityKey" in c ? `delete:${c.entity}` : `upsert:${c.entity}`))).toEqual([
			"upsert:template",
			"upsert:dataset",
			"upsert:profile",
			"upsert:setting",
			"upsert:font",
		]);
		const seqs = page.changes.map((c) => c.seq);
		expect([...seqs].sort((a, b) => (a < b ? -1 : 1))).toEqual(seqs);

		// Shape spot-checks: font metadata rides without bytes, the
		// setting key is the entity key analogue.
		const font = page.changes.find((c) => c.entity === "font");
		expect(font && "data" in font && font.entity === "font" && font.data.name).toBe("Body");
		expect(font && "data" in font && "bytes" in font.data).toBe(false);
		const setting = page.changes.find((c) => c.entity === "setting");
		expect(setting && "data" in setting && setting.entity === "setting" && setting.data.key).toBe("ui_density");

		await deps.datasets.deleteWithTombstone(datasetId);
		const after = await deps.sync.readSince(
			userId,
			{ cursor: page.nextCursor, limit: 100, types: [...ALL] },
			8 * 1024 * 1024,
		);
		expect(after.changes).toHaveLength(1);
		expect(after.changes[0]).toMatchObject({ entity: "dataset", entityKey: datasetId });
	});

	it("filters by types", async () => {
		const deps = realDeps(stack.db);
		const userId = randomUUID();
		await stack.db.user.create({
			data: { id: userId, handle: "Filter", handleKey: "filter", passwordHash: "x" },
		});
		await deps.datasets.create({ id: randomUUID(), ownerId: userId, name: "D", dataJson: "{}" });
		await deps.fonts.create({ id: randomUUID(), ownerId: userId, name: "F" });

		const onlyFonts = await deps.sync.readSince(userId, { cursor: 0n, limit: 100, types: ["font"] }, 8 * 1024 * 1024);
		expect(onlyFonts.changes).toHaveLength(1);
		expect(onlyFonts.changes[0]?.entity).toBe("font");

		const neither = await deps.sync.readSince(
			userId,
			{ cursor: 0n, limit: 100, types: ["template", "profile"] },
			8 * 1024 * 1024,
		);
		expect(neither.changes).toEqual([]);
	});
});

describe("sync changes over HTTP", () => {
	async function register(handle: string): Promise<string> {
		const response = await app.inject({
			method: "POST",
			url: "/v2/auth/register",
			payload: { handle, password: "password123" },
		});
		expect(response.statusCode).toBe(201);
		return (response.json() as { token: string }).token;
	}

	it("serves library upserts with their wire shapes", async () => {
		const token = await register("SyncHttp");
		const headers = { authorization: `Bearer ${token}` };

		const datasetId = randomUUID();
		await app.inject({
			method: "PUT",
			url: `/v2/datasets/${datasetId}`,
			headers,
			payload: { name: "Orders", dataJson: '{"rows":[]}' },
		});
		const fontId = randomUUID();
		await app.inject({ method: "PUT", url: `/v2/fonts/${fontId}`, headers, payload: { name: "Body" } });
		await app.inject({
			method: "PUT",
			url: `/v2/settings/brand_name`,
			headers,
			payload: { value: "Acme" },
		});

		const response = await app.inject({
			method: "GET",
			url: "/v2/sync/changes?types=dataset,font,setting",
			headers,
		});
		expect(response.statusCode).toBe(200);
		const body = response.json() as {
			changes: Array<{ entity: string; op: string; data?: Record<string, unknown> }>;
		};
		expect(body.changes.map((c) => c.entity).sort()).toEqual(["dataset", "font", "setting"]);
		for (const change of body.changes) {
			expect(change.op).toBe("upsert");
		}
		const dataset = body.changes.find((c) => c.entity === "dataset");
		expect(dataset?.data).toMatchObject({ id: datasetId, name: "Orders", revision: 1 });
		const setting = body.changes.find((c) => c.entity === "setting");
		expect(setting?.data).toMatchObject({ key: "brand_name", value: "Acme" });
	});
});
