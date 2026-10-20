import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { testConfig } from "../helpers.js";
import { realDeps, startTestDatabase, truncateAll, type TestStack } from "./db.js";

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

async function register(handle: string): Promise<string> {
	const response = await app.inject({
		method: "POST",
		url: "/v2/auth/register",
		payload: { handle, password: "password123" },
	});
	expect(response.statusCode).toBe(201);
	return (response.json() as { token: string }).token;
}

const headers = (token?: string) => (token ? { authorization: `Bearer ${token}` } : {});

async function put(id: string, token: string, body: Record<string, unknown>) {
	const response = await app.inject({ method: "PUT", url: `/v2/templates/${id}`, headers: headers(token), payload: body });
	return { status: response.statusCode, json: response.json() as Record<string, unknown> };
}

const tpl = (name: string, extra: Record<string, unknown> = {}) => ({
	name,
	summary: "",
	page_w_mm: 101.6,
	page_h_mm: 152.4,
	language: "html",
	body: `<div>${name}</div>`,
	readme: "",
	...extra,
});

interface Change {
	seq: string;
	entity: string;
	op: string;
	id?: string;
	data?: { id: string; revision: number; head_version_no: number };
}

async function changes(token: string, query: string) {
	const response = await app.inject({ method: "GET", url: `/v2/sync/changes${query}`, headers: headers(token) });
	return { status: response.statusCode, json: response.json() as { changes: Change[]; next_cursor: string; has_more: boolean; reset: boolean } };
}

describe("GET /v2/sync/changes", () => {
	it("reads everything from an empty since, then incrementally", async () => {
		const token = await register("sync-reader");
		const a = randomUUID();
		const b = randomUUID();
		await put(a, token, tpl("A"));
		await put(b, token, tpl("B"));

		const full = await changes(token, "");
		expect(full.status).toBe(200);
		expect(full.json.reset).toBe(false);
		expect(full.json.has_more).toBe(false);
		expect(full.json.changes.map((c) => c.seq)).toEqual(["2", "3"]);
		const first = full.json.changes[0];
		expect(first?.op).toBe("upsert");
		expect(first?.data).toMatchObject({ id: a, revision: 1, head_version_no: 1 });

		const cursor = full.json.next_cursor;
		const empty = await changes(token, `?since=${encodeURIComponent(cursor)}`);
		expect(empty.json.changes).toEqual([]);
		expect(empty.json.has_more).toBe(false);

		await put(a, token, tpl("A2", { if_revision: 1 }));
		const inc = await changes(token, `?since=${encodeURIComponent(cursor)}`);
		expect(inc.json.changes.map((c) => c.seq)).toEqual(["4"]);
		expect(inc.json.changes[0]?.data).toMatchObject({ id: a, revision: 2, head_version_no: 2 });
	});

	it("reports deletes as delete records", async () => {
		const token = await register("sync-deleter");
		const id = randomUUID();
		await put(id, token, tpl("Gone"));
		const before = await changes(token, "");
		const cursor = before.json.next_cursor;

		await app.inject({ method: "DELETE", url: `/v2/templates/${id}`, headers: headers(token) });
		const after = await changes(token, `?since=${encodeURIComponent(cursor)}`);
		expect(after.json.changes).toHaveLength(1);
		const del = after.json.changes[0] as Change;
		expect(del).toMatchObject({ op: "delete", entity: "template", id });
		expect(typeof del.seq).toBe("string");
	});

	it("answers reset with a full pass for a cursor below the tombstone floor", async () => {
		const token = await register("sync-reset");
		const id = randomUUID();
		await put(id, token, tpl("R"));
		await app.inject({ method: "DELETE", url: `/v2/templates/${id}`, headers: headers(token) });

	 // since=0 predates every tombstone, so the cursor is stale.
		const stale = await changes(token, "?since=MA");
		expect(stale.json.reset).toBe(true);
		expect(stale.json.changes.map((c) => (c.op === "delete" ? `delete:${c.id}` : "upsert"))).toContain(
			`delete:${id}`,
		);
	});

	it("rejects an unreadable cursor and unknown types with 400", async () => {
		const token = await register("sync-bad");
		expect((await changes(token, "?since=not-a-cursor!!")).status).toBe(400);
		expect((await changes(token, "?types=template,nope")).status).toBe(400);
	});

	it("paginates by limit with next_cursor and filters types", async () => {
		const token = await register("sync-pages");
		for (const name of ["p1", "p2", "p3"]) {
			await put(randomUUID(), token, tpl(name));
		}
		const first = await changes(token, "?limit=2");
		expect(first.json.changes).toHaveLength(2);
		expect(first.json.has_more).toBe(true);

		const second = await changes(token, `?limit=2&since=${encodeURIComponent(first.json.next_cursor)}`);
		expect(second.json.changes).toHaveLength(1);
		expect(second.json.has_more).toBe(false);

		const fonts = await changes(token, "?types=font");
		expect(fonts.json.changes).toEqual([]);
		const mixed = await changes(token, "?types=template,font");
		expect(mixed.json.changes).toHaveLength(3);
	});

	it("returns an empty page with the same cursor when up to date", async () => {
		const token = await register("sync-empty");
		await put(randomUUID(), token, tpl("E"));
		const full = await changes(token, "");
		const again = await changes(token, `?since=${encodeURIComponent(full.json.next_cursor)}`);
		expect(again.json.changes).toEqual([]);
		expect(again.json.next_cursor).toBe(full.json.next_cursor);
		expect(again.json.has_more).toBe(false);
		expect(again.json.reset).toBe(false);
	});
});

describe("GET /v2/saved/manifest", () => {
	it("tracks revision and published/withdrawn/deleted states", async () => {
		const owner = await register("m-owner");
		const reader = await register("m-reader");
		const id = randomUUID();
		await put(id, owner, tpl("M"));
		await app.inject({ method: "POST", url: `/v2/templates/${id}/publish`, headers: headers(owner) });
		await app.inject({ method: "PUT", url: `/v2/saved/${id}`, headers: headers(reader) });

	 const manifest = async () =>
			(await app.inject({ method: "GET", url: "/v2/saved/manifest", headers: headers(reader) })).json() as {
				items: { id: string; revision: number; state: string; owner_handle: string }[];
			};
		expect((await manifest()).items).toEqual([
			{ id, revision: 1, state: "published", owner_handle: "m-owner", updated_at: expect.any(String) },
		]);

		await put(id, owner, tpl("M2", { if_revision: 1 }));
		expect((await manifest()).items[0]).toMatchObject({ revision: 2, state: "published" });

		await app.inject({ method: "POST", url: `/v2/templates/${id}/unpublish`, headers: headers(owner) });
		expect((await manifest()).items[0]).toMatchObject({ revision: 2, state: "withdrawn" });

		await app.inject({ method: "POST", url: `/v2/templates/${id}/publish`, headers: headers(owner) });
		expect((await manifest()).items[0]).toMatchObject({ revision: 2, state: "published" });

	 await app.inject({ method: "DELETE", url: `/v2/templates/${id}`, headers: headers(owner) });
	 expect((await manifest()).items).toEqual([
			{ id, revision: 0, state: "deleted", owner_handle: "", updated_at: expect.any(String) },
		]);
	});

	it("needs auth", async () => {
		expect((await app.inject({ method: "GET", url: "/v2/saved/manifest" })).statusCode).toBe(401);
	});
});
