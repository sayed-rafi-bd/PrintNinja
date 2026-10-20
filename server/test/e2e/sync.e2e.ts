import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// E10-E12 and E14 (REFACTORING.md section 11) over HTTP against a
// running container: `docker compose up -d`, then E2E_BASE_URL=...
// test:e2e. The integration suite pins the same behaviors through
// inject; these replay them through the real socket and image.

const baseUrl = process.env.E2E_BASE_URL;
if (!baseUrl) {
	throw new Error("E2E_BASE_URL is not set — start the stack first (docker compose up -d)");
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

const runId = Date.now().toString(36);
const handle = (name: string) => `${name}-${runId}`;

async function request(method: string, path: string, token?: string, body?: unknown) {
	// No keep-alive: each request opens a fresh connection. A pooled
	// socket goes stale across E10's service restart and would fail the
	// next test with a socket error instead of an assertion.
	const headers: Record<string, string> = { connection: "close" };
	if (body !== undefined) {
		headers["content-type"] = "application/json";
	}
	if (token !== undefined) {
		headers.authorization = `Bearer ${token}`;
	}
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	return { status: response.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

async function register(name: string): Promise<{ token: string; user: { id: string } }> {
	const reg = await request("POST", "/v2/auth/register", undefined, { handle: handle(name), password: "password123" });
	expect(reg.status).toBe(201);
	return reg.json as unknown as { token: string; user: { id: string } };
}

async function login(name: string): Promise<string> {
	const res = await request("POST", "/v2/auth/login", undefined, { handle: handle(name), password: "password123" });
	expect(res.status).toBe(200);
	return (res.json as { token: string }).token;
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

async function waitForHealth(timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const res = await fetch(`${baseUrl}/v2/health`);
			if (res.ok) {
				return;
			}
		} catch {
			// Not listening yet.
		}
		if (Date.now() > deadline) {
			throw new Error("service did not become healthy in time");
		}
		await new Promise((r) => setTimeout(r, 500));
	}
}

describe("E10 delta sync", () => {
	it("streams creates, edits, publish and delete in order, survives a restart, resets stale cursors", async () => {
		const owner = await register("e10owner");
		const t1 = crypto.randomUUID();
	 const t2 = crypto.randomUUID();
		expect((await request("PUT", `/v2/templates/${t1}`, owner.token, tpl("E10 one"))).status).toBe(201);
		expect((await request("PUT", `/v2/templates/${t1}`, owner.token, tpl("E10 one", { body: "<div>edited</div>", if_revision: 1 }))).status).toBe(200);
		expect((await request("POST", `/v2/templates/${t1}/publish`, owner.token)).status).toBe(200);
		expect((await request("PUT", `/v2/templates/${t2}`, owner.token, tpl("E10 two"))).status).toBe(201);
		expect((await request("DELETE", `/v2/templates/${t2}`, owner.token)).status).toBe(204);

		// A reader follows from the start, two records per page.
	 const seen: { seq: string; kind: string; id: string }[] = [];
		let cursor: string | undefined;
		let hasMore = true;
		while (hasMore) {
			const page = await request("GET", `/v2/sync/changes?limit=2${cursor ? `&since=${cursor}` : ""}`, owner.token);
			expect(page.status).toBe(200);
			const body = page.json as { changes: { seq: string; op: string; id?: string; data?: { id: string } }[]; next_cursor: string; has_more: boolean; reset: boolean };
			expect(body.reset).toBe(false);
			for (const c of body.changes) {
				seen.push({ seq: c.seq, kind: c.op, id: c.op === "delete" ? (c.id as string) : (c.data as { id: string }).id });
			}
			cursor = body.next_cursor;
			hasMore = body.has_more;
		}
		// Each change once, in order: create, edit, delete.
	 expect(seen.map((s) => `${s.kind}:${s.id}`)).toEqual([
			`upsert:${t1}`,
			`delete:${t2}`,
		]);
		const seqs = seen.map((s) => BigInt(s.seq));
		expect([...seqs].sort((a, b) => (a < b ? -1 : 1))).toEqual(seqs);

		// An up-to-date cursor returns an empty page.
		const empty = await request("GET", `/v2/sync/changes?since=${cursor}`, owner.token);
		expect(((empty.json as { changes: unknown[] }).changes)).toEqual([]);
		expect((empty.json as { has_more: boolean }).has_more).toBe(false);

		// A cursor survives a restart of the service.
		execSync("docker compose restart server", { cwd: repoRoot, stdio: "pipe" });
		await waitForHealth(90_000);
		const afterRestart = await request("GET", `/v2/sync/changes?since=${cursor}`, owner.token);
		expect(((afterRestart.json as { changes: unknown[] }).changes)).toEqual([]);

		// A cursor older than the tombstone floor gives reset with a full pass.
	 const stale = await request("GET", "/v2/sync/changes?since=MA", owner.token);
	 expect((stale.json as { reset: boolean }).reset).toBe(true);
		expect(((stale.json as { changes: { op: string }[] }).changes.length)).toBeGreaterThan(0);
	});
});

describe("E11 revisions", () => {
	it("one 200 and one 409, retry replays, publish does not conflict the next push", async () => {
	 await register("e11owner");
		const a = await login("e11owner");
		const b = await login("e11owner");
		const id = crypto.randomUUID();
		expect((await request("PUT", `/v2/templates/${id}`, a, tpl("E11"))).status).toBe(201);

		const winner = await request("PUT", `/v2/templates/${id}`, a, tpl("E11", { body: "<div>a</div>", if_revision: 1 }));
		expect(winner.status).toBe(200);
		const loser = await request("PUT", `/v2/templates/${id}`, b, tpl("E11", { body: "<div>b</div>", if_revision: 1 }));
		expect(loser.status).toBe(409);

		const retry = await request("PUT", `/v2/templates/${id}`, b, tpl("E11", { body: "<div>a</div>", if_revision: 1 }));
		expect(retry.status).toBe(200);
		expect((retry.json as { revision: number }).revision).toBe(2);

		expect((await request("POST", `/v2/templates/${id}/publish`, a)).status).toBe(200);
		const afterPublish = await request("PUT", `/v2/templates/${id}`, b, tpl("E11", { body: "<div>c</div>", if_revision: 2 }));
		expect(afterPublish.status).toBe(200);
	});
});

describe("E12 version history", () => {
	it("three saves give three versions, restore appends a restore, newest cannot go", async () => {
		const owner = await register("e12owner");
		const id = crypto.randomUUID();
		expect((await request("PUT", `/v2/templates/${id}`, owner.token, tpl("E12"))).status).toBe(201);
		expect((await request("PUT", `/v2/templates/${id}`, owner.token, tpl("E12", { body: "<div>v2</div>", if_revision: 1 }))).status).toBe(200);
		expect((await request("PUT", `/v2/templates/${id}`, owner.token, tpl("E12", { body: "<div>v3</div>", if_revision: 2 }))).status).toBe(200);

		const list = await request("GET", `/v2/templates/${id}/versions?page_size=100`, owner.token);
		expect(((list.json as { items: { version_no: number }[] }).items).map((v) => v.version_no)).toEqual([3, 2, 1]);

		const restored = await request("POST", `/v2/templates/${id}/versions/1/restore`, owner.token, { if_revision: 3 });
		expect(restored.status).toBe(200);
		const after = await request("GET", `/v2/templates/${id}/versions?page_size=100`, owner.token);
	 const versions = (after.json as { items: { version_no: number; created_by: string }[] }).items;
		expect(versions.map((v) => v.version_no)).toEqual([4, 3, 2, 1]);
		expect(versions[0]).toMatchObject({ created_by: "restore" });

		expect((await request("DELETE", `/v2/templates/${id}/versions/4`, owner.token)).status).toBe(400);
		expect((await request("DELETE", `/v2/templates/${id}/versions/2`, owner.token)).status).toBe(204);
	}, 120_000);

	it("sixty autosaves leave fifty", async () => {
		const owner = await register("e12auto");
		const id = crypto.randomUUID();
		expect((await request("PUT", `/v2/templates/${id}`, owner.token, tpl("E12 auto"))).status).toBe(201);
		for (let i = 0; i < 60; i += 1) {
			const got = await request("GET", `/v2/templates/${id}`, owner.token);
			const rev = (got.json as { revision: number }).revision;
			const updated = await request("PUT", `/v2/templates/${id}`, owner.token, {
				...tpl("E12 auto"),
				body: `<div>a${i}</div>`,
				if_revision: rev,
				version: { created_by: "autosave" },
			});
			expect(updated.status, `autosave ${i}`).toBe(200);
		}
		const list = await request("GET", `/v2/templates/${id}/versions?page_size=100`, owner.token);
		const items = (list.json as { items: { version_no: number; created_by: string }[] }).items;
		expect(items.filter((v) => v.created_by === "autosave")).toHaveLength(50);
		expect(items.some((v) => v.created_by === "manual")).toBe(true);
	}, 180_000);
});

describe("E14 saved manifest", () => {
	it("tracks revision, withdrawal, republication and deletion", async () => {
		const owner = await register("e14owner");
		const reader = await register("e14reader");
		const id = crypto.randomUUID();
	 const put = (body: unknown) => request("PUT", `/v2/templates/${id}`, owner.token, body);
		expect((await put(tpl("E14"))).status).toBe(201);
		expect((await request("POST", `/v2/templates/${id}/publish`, owner.token)).status).toBe(200);
		expect((await request("PUT", `/v2/saved/${id}`, reader.token)).status).toBe(204);

		const manifest = async () =>
			((await request("GET", "/v2/saved/manifest", reader.token)).json as {
				items: { id: string; revision: number; state: string }[];
			}).items;
		expect(await manifest()).toEqual([
			{ id, revision: 1, state: "published", owner_handle: "e14owner-" + runId, updated_at: expect.any(String) },
		]);

		expect((await put(tpl("E14", { body: "<div>e2</div>", if_revision: 1 }))).status).toBe(200);
		expect(await manifest()).toMatchObject([{ revision: 2, state: "published" }]);

		expect((await request("POST", `/v2/templates/${id}/unpublish`, owner.token)).status).toBe(204);
		expect(await manifest()).toMatchObject([{ revision: 2, state: "withdrawn" }]);

		expect((await request("POST", `/v2/templates/${id}/publish`, owner.token)).status).toBe(200);
		expect(await manifest()).toMatchObject([{ revision: 2, state: "published" }]);

		expect((await request("DELETE", `/v2/templates/${id}`, owner.token)).status).toBe(204);
		expect(await manifest()).toMatchObject([{ id, revision: 0, state: "deleted" }]);
	}, 120_000);
});
