import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("remote versions", () => {
	beforeEach(() => {
		localStorage.clear();
		// A fresh host: the typed client caches per base URL, so reusing
		// api.test would replay an earlier test's fetch mock.
		localStorage.setItem("printninja-setting:share_service_url", "https://api-versions.test");
		localStorage.setItem("printninja-setting:share_session_token", "tok");
	});

	function stubFetch(body: unknown, status = 200) {
		const seen: string[] = [];
		const seenBodies: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const req = input instanceof Request ? input : new Request(input as string, init);
				seen.push(`${req.method} ${req.url}`);
				if (req.method === "PUT" || req.method === "POST") {
					seenBodies.push(init?.body ? String(init.body) : await req.text().catch(() => ""));
				}
				return new Response(JSON.stringify(body), { status });
			}),
		);
		return { seen, seenBodies };
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("lists, reads, restores and deletes versions through /v2", async () => {
		const { seen, seenBodies } = stubFetch({ items: [{ version_no: 2 }] });
		const { listRemoteVersions, readRemoteVersion, restoreRemoteVersion, deleteRemoteVersion, putRemoteTemplate } =
			await import("@/lib/share/client");

		await listRemoteVersions("tid");
		await readRemoteVersion("tid", 2);
		await restoreRemoteVersion("tid", 1, 4);
		await deleteRemoteVersion("tid", 1);
		await putRemoteTemplate({
			id: "tid",
			name: "T",
			page_w_mm: 210,
			page_h_mm: 297,
			body: "<p></p>",
			version: { label: "L", note: null },
		});

		expect(seen).toEqual([
			"GET https://api-versions.test/v2/templates/tid/versions?page=1&page_size=20",
			"GET https://api-versions.test/v2/templates/tid/versions/2",
			"POST https://api-versions.test/v2/templates/tid/versions/1/restore",
			"DELETE https://api-versions.test/v2/templates/tid/versions/1",
			"PUT https://api-versions.test/v2/templates/tid",
		]);
		// Null version fields are stripped: the schema takes strings, not nulls.
		expect(JSON.parse(seenBodies[seenBodies.length - 1])).toEqual(
			expect.objectContaining({ version: { label: "L" } }),
		);
	});
});
