import { describe, expect, it } from "vitest";

// E1 + E8 (REFACTORING.md section 11) over HTTP against a running
// container: `docker compose up -d`, then
// `E2E_BASE_URL=http://localhost:3001 pnpm --filter server test:e2e`.
// Same behaviors the integration suite pins through inject, replayed
// through the real socket, image and PostgreSQL — the layer that caught
// the image-only zod and version.js bugs. Handles carry a run-unique
// suffix so repeated runs against one stack never collide.

const baseUrl = process.env.E2E_BASE_URL;
if (!baseUrl) {
	throw new Error("E2E_BASE_URL is not set — start the stack first (docker compose up -d)");
}

const runId = Date.now().toString(36);
const handle = (name: string) => `${name}-${runId}`;

interface AuthBody {
	token: string;
	expires_at: string;
	user: { id: string; handle: string; created_at: string };
}

interface Envelope {
	error: { code: string; message: string; request_id: string };
}

async function post(path: string, body?: unknown, token?: string) {
	const headers: Record<string, string> = {};
	if (body !== undefined) {
		headers["content-type"] = "application/json";
	}
	if (token !== undefined) {
		headers.authorization = `Bearer ${token}`;
	}
	const response = await fetch(`${baseUrl}${path}`, {
		method: "POST",
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	const json = (text ? JSON.parse(text) : {}) as AuthBody & Envelope;
	return { status: response.status, json, headers: response.headers };
}

describe("E1 account lifecycle", () => {
	it("register, me, logout, expired token, login, me", async () => {
		const reg = await post("/v2/auth/register", {
			handle: handle("e1"),
			password: "password123",
		});
		expect(reg.status).toBe(201);
		expect(reg.json.token.length).toBeGreaterThan(20);

		const me = await fetch(`${baseUrl}/v2/auth/me`, {
			headers: { authorization: `Bearer ${reg.json.token}` },
		});
		expect(me.status).toBe(200);
		expect(((await me.json()) as { handle: string }).handle).toBe(handle("e1"));

		const logout = await post("/v2/auth/logout", undefined, reg.json.token);
		expect(logout.status).toBe(204);

		const after = await fetch(`${baseUrl}/v2/auth/me`, {
			headers: { authorization: `Bearer ${reg.json.token}` },
		});
		expect(after.status).toBe(401);

		const login = await post("/v2/auth/login", {
			handle: handle("e1"),
			password: "password123",
		});
		expect(login.status).toBe(200);
		const meAgain = await fetch(`${baseUrl}/v2/auth/me`, {
			headers: { authorization: `Bearer ${login.json.token}` },
		});
		expect(meAgain.status).toBe(200);
	});

	it("wrong password and unknown handle give the same invalid_credentials", async () => {
		const wrong = await post("/v2/auth/login", {
			handle: handle("e1"),
			password: "wrongpassword",
		});
		const unknown = await post("/v2/auth/login", {
			handle: handle("nobody-here"),
			password: "password123",
		});
		expect(wrong.status).toBe(401);
		expect(unknown.status).toBe(401);
		expect(wrong.json.error.code).toBe("invalid_credentials");
		expect(unknown.json.error.code).toBe("invalid_credentials");
		expect(unknown.json.error.message).toBe(wrong.json.error.message);
	});

	it("the same handle in another case gives 409", async () => {
		const first = await post("/v2/auth/register", {
			handle: `Case-${runId}`,
			password: "password123",
		});
		expect(first.status).toBe(201);
		const second = await post("/v2/auth/register", {
			handle: `case-${runId}`,
			password: "password123",
		});
		expect(second.status).toBe(409);
		expect(second.json.error.code).toBe("handle_taken");
	});
});

describe("E8 rate limit", () => {
	it("the eleventh login in the window gives 429 with Retry-After", async () => {
		const name = handle("e8");
		for (let i = 0; i < 10; i += 1) {
			const attempt = await post("/v2/auth/login", {
				handle: name,
				password: "wrongpassword",
			});
			expect(attempt.status).toBe(401);
		}
		const limited = await post("/v2/auth/login", {
			handle: name,
			password: "wrongpassword",
		});
		expect(limited.status).toBe(429);
		expect(limited.json.error.code).toBe("rate_limited");
		expect(limited.headers.get("retry-after")).not.toBeNull();

		// Another handle from another address is unaffected; the address
		// here is shared, so a fresh handle proves the key includes it.
		const fresh = await post("/v2/auth/login", {
			handle: handle("e8-other"),
			password: "wrongpassword",
		});
		expect(fresh.status).toBe(401);
	});
});
