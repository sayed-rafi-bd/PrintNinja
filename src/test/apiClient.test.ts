import { beforeEach, describe, expect, it, vi } from "vitest";
import { callApi, type ApiDeps } from "@/lib/api/client";
import { ApiError, ServerUnreachableError, SessionExpiredError } from "@/lib/api/errors";

function mockFetch(handler: (req: Request) => Response | Promise<Response>) {
	const seen: Request[] = [];
	const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const req = new Request(input, init);
		seen.push(req);
		return handler(req);
	});
	return { fetch: fetch as unknown as typeof globalThis.fetch, seen };
}

function deps(overrides: Partial<ApiDeps> & { token?: string | null } = {}): ApiDeps {
	return {
		getBaseUrl: async () => "https://api.test",
		getToken: async () => (overrides.token !== undefined ? overrides.token : "tok"),
		onUnauthorized: vi.fn(),
		...overrides,
	};
}

function envelope(code = "handle_taken", status = 409) {
	return new Response(
		JSON.stringify({ error: { code, message: `${code} happened`, request_id: "req-1" } }),
		{ status, headers: { "Content-Type": "application/json" } },
	);
}

describe("typed api client", () => {
	it("attaches the bearer token and returns typed data", async () => {
		const { fetch, seen } = mockFetch(
			() => new Response(JSON.stringify({ token: "t", user: { id: "1", handle: "Rafi" } }), { status: 201 }),
		);
		const data = await callApi<{ token: string }>(deps({ fetch }), {
			method: "POST",
			path: "/v2/auth/register",
			body: { handle: "Rafi", password: "x" },
		});

		expect(data).toMatchObject({ token: "t" });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.headers.get("authorization")).toBe("Bearer tok");
		expect(seen[0]?.url).toBe("https://api.test/v2/auth/register");
	});

	it("omits the header when there is no token", async () => {
		const { fetch, seen } = mockFetch(() => new Response("{}", { status: 200 }));
		await callApi(deps({ fetch, token: null }), { method: "GET", path: "/v2/auth/me" });

		expect(seen[0]?.headers.get("authorization")).toBeNull();
	});

	it("ends the session once and throws SessionExpiredError on 401", async () => {
		const onUnauthorized = vi.fn();
		const { fetch } = mockFetch(() => new Response("{}", { status: 401 }));
		const call = callApi(deps({ fetch, onUnauthorized }), { method: "GET", path: "/v2/auth/me" });

		await expect(call).rejects.toBeInstanceOf(SessionExpiredError);
		expect(onUnauthorized).toHaveBeenCalledTimes(1);
	});

	it("turns the error envelope into a typed ApiError", async () => {
		const { fetch } = mockFetch(() => envelope("revision_conflict", 409));
		const call = callApi(deps({ fetch }), { method: "PUT", path: "/v2/templates/1" });

		const error = await call.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(error as ApiError).toMatchObject({ code: "revision_conflict", status: 409, requestId: "req-1" });
		expect((error as Error).message).toBe("revision_conflict happened");
	});

	it("turns an unauthenticated 401 envelope into an ApiError without ending the session", async () => {
		const onUnauthorized = vi.fn();
		const { fetch } = mockFetch(() => envelope("invalid_credentials", 401));
		const call = callApi(deps({ fetch, token: null, onUnauthorized }), {
			method: "POST",
			path: "/v2/auth/login",
			body: { handle: "Rafi", password: "wrong" },
		});

		const error = await call.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).message).toBe("invalid_credentials happened");
		expect(onUnauthorized).not.toHaveBeenCalled();
	});

	it("reports unreachable servers with the base url", async () => {
		const { fetch } = mockFetch(() => {
			throw new TypeError("fetch failed");
		});
		const call = callApi(deps({ fetch }), { method: "GET", path: "/v2/health" });

		const error = await call.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ServerUnreachableError);
		expect((error as ServerUnreachableError).url).toBe("https://api.test");
	});

	it("requires a configured server", async () => {
		const { fetch } = mockFetch(() => new Response("{}", { status: 200 }));
		const call = callApi({ getBaseUrl: async () => null, getToken: async () => null, onUnauthorized: () => {}, fetch }, {
			method: "GET",
			path: "/v2/health",
		});

		await expect(call).rejects.toThrow("Share service not configured");
	});

	it("rebuilds the client when the server address changes", async () => {
		const { fetch, seen } = mockFetch(() => new Response("{}", { status: 200 }));
		let url: string | null = "https://one.test";
		const d = deps({ fetch });
		d.getBaseUrl = async () => url;

		await callApi(d, { method: "GET", path: "/v2/health" });
		url = "https://two.test";
		await callApi(d, { method: "GET", path: "/v2/health" });

		expect(seen.map((r) => new URL(r.url).host)).toEqual(["one.test", "two.test"]);
	});
});

describe("fetchCommunityTemplates", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("passes search, sort and paging through and returns the items", async () => {
		localStorage.setItem("printninja-setting:share_service_url", "https://api.test");
		localStorage.setItem("printninja-setting:share_session_token", "tok");
		const seen: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const req = input instanceof Request ? input : new Request(input as string);
				seen.push(req.url);
				return new Response(JSON.stringify({ items: [{ id: "1" }], has_more: false }), { status: 200 });
			}),
		);
		try {
			const { fetchCommunityTemplates } = await import("@/lib/share/client");
			const items = await fetchCommunityTemplates({ q: "  invoice ", sort: "used" });
			expect(items).toEqual([{ id: "1" }]);
			const url = new URL(seen[0]);
			expect(url.pathname).toBe("/v2/community/templates");
			expect(url.searchParams.get("q")).toBe("invoice");
			expect(url.searchParams.get("sort")).toBe("used");
			expect(url.searchParams.get("page")).toBe("1");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
