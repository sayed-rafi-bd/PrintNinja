import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { testConfig } from "../helpers.js";
import { realDeps, startTestDatabase, truncateAll, type TestStack } from "./db.js";

// Endpoints 27-32 (Phase 4, deliverable 1): account preferences with the
// allow-list enforced, and fonts with magic-byte checks, sizes and the
// SHA-256 ETag round trip.

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

function headers(token?: string): Record<string, string> {
	return token ? { authorization: `Bearer ${token}` } : {};
}

// Minimal TTF: 00 01 00 00 magic.
const ttfBytes = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

async function putFont(token: string, id: string, name = "Body") {
	return app.inject({
		method: "PUT",
		url: `/v2/fonts/${id}`,
		headers: headers(token),
		payload: { name },
	});
}

async function putFile(token: string, id: string, bytes: Buffer) {
	return app.inject({
		method: "PUT",
		url: `/v2/fonts/${id}/file`,
		headers: { ...headers(token), "content-type": "application/octet-stream" },
		payload: bytes,
	});
}

describe("settings", () => {
	it("sets and resets allow-listed keys, and refuses the rest", async () => {
		const token = await register("SettingsUser");

		for (const key of ["ui_density", "brand_name", "brand_logo"]) {
			const created = await app.inject({
				method: "PUT",
				url: `/v2/settings/${key}`,
				headers: headers(token),
				payload: { value: "v" },
			});
			expect(created.statusCode).toBe(201);
			expect(created.json()).toMatchObject({ key, value: "v", revision: 1 });
		}

		const updated = await app.inject({
			method: "PUT",
			url: "/v2/settings/ui_density",
			headers: headers(token),
			payload: { value: "compact" },
		});
		expect(updated.statusCode).toBe(200);
		expect(updated.json()).toMatchObject({ value: "compact", revision: 2 });

		const refused = await app.inject({
			method: "PUT",
			url: "/v2/settings/api_port",
			headers: headers(token),
			payload: { value: "1234" },
		});
		expect(refused.statusCode).toBe(400);

		const reset = await app.inject({ method: "DELETE", url: "/v2/settings/ui_density", headers: headers(token) });
		expect(reset.statusCode).toBe(204);

		// Deleting again is a no-op, and unknown keys never get in.
		const again = await app.inject({ method: "DELETE", url: "/v2/settings/ui_density", headers: headers(token) });
		expect(again.statusCode).toBe(204);
		const anon = await app.inject({ method: "PUT", url: "/v2/settings/brand_name", payload: { value: "x" } });
		expect(anon.statusCode).toBe(401);
	});
});

describe("fonts", () => {
	it("creates metadata, uploads bytes, downloads with the sha ETag, and deletes", async () => {
		const token = await register("FontUser");
		const id = randomUUID();

		const created = await putFont(token, id, "Body");
		expect(created.statusCode).toBe(201);
		expect(created.json()).toMatchObject({ id, name: "Body", format: "", revision: 1 });

		const uploaded = await putFile(token, id, ttfBytes);
		expect(uploaded.statusCode).toBe(200);
		const meta = uploaded.json() as { format: string; size_bytes: number; sha256: string; revision: number };
		expect(meta).toMatchObject({ format: "ttf", size_bytes: ttfBytes.length, revision: 2 });
		expect(typeof meta.sha256).toBe("string");
		expect(meta.sha256).toHaveLength(64);

		const download = await app.inject({ method: "GET", url: `/v2/fonts/${id}/file`, headers: headers(token) });
		expect(download.statusCode).toBe(200);
		expect(download.headers["etag"]).toBe(`"${meta.sha256}"`);
		expect(download.headers["content-type"]).toBe("application/octet-stream");
		expect((download.body as string).length).toBeGreaterThan(0);

		const cached = await app.inject({
			method: "GET",
			url: `/v2/fonts/${id}/file`,
			headers: { ...headers(token), "if-none-match": `"${meta.sha256}"` },
		});
		expect(cached.statusCode).toBe(304);

		const deleted = await app.inject({ method: "DELETE", url: `/v2/fonts/${id}`, headers: headers(token) });
		expect(deleted.statusCode).toBe(204);
		const gone = await app.inject({ method: "GET", url: `/v2/fonts/${id}/file`, headers: headers(token) });
		expect(gone.statusCode).toBe(404);
	});

	it("rejects the wrong content, oversize files and other owners", async () => {
		const mine = await register("FontOwner");
		const theirs = await register("FontStranger");
		const id = randomUUID();
		await putFont(mine, id);

		const wrong = await putFile(mine, id, Buffer.from("%PDF-1.4 nope"));
		expect(wrong.statusCode).toBe(400);
		expect(wrong.json()).toMatchObject({ error: expect.objectContaining({ code: "validation_failed" }) });

		const huge = await putFile(mine, id, Buffer.alloc(5 * 1024 * 1024 + 1, 1));
		expect([400, 413]).toContain(huge.statusCode);

		const foreign = await putFile(theirs, id, ttfBytes);
		expect(foreign.statusCode).toBe(403);

		const missing = await putFile(mine, randomUUID(), ttfBytes);
		expect(missing.statusCode).toBe(404);
	});

	it("caps fonts per user and requires auth", async () => {
		const token = await register("FontQuota");
		for (let i = 0; i < 50; i += 1) {
			const res = await putFont(token, randomUUID(), `F${i}`);
			expect(res.statusCode).toBe(201);
		}
		const over = await putFont(token, randomUUID(), "F51");
		expect(over.statusCode).toBe(409);
		const anon = await app.inject({ method: "PUT", url: `/v2/fonts/${randomUUID()}`, payload: { name: "X" } });
		expect(anon.statusCode).toBe(401);
	});
});
