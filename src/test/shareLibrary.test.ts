import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

// The library client (endpoints 23-32): datasets, profiles, settings and
// fonts through /v2, following the shareVersions.test.ts pattern — a
// stubbed global fetch with the service URL and token in localStorage
// (the Tauri agent is unreachable in Vitest, so getSetting falls back).

describe("library client", () => {
	let hostNo = 0;

	beforeEach(() => {
		localStorage.clear();
		// The typed client caches per base URL, so each test gets its
		// own host — otherwise an earlier test's fetch mock answers.
		hostNo += 1;
		localStorage.setItem("printninja-setting:share_service_url", `https://api-library-${hostNo}.test`);
		localStorage.setItem("printninja-setting:share_session_token", "tok");
	});

	function stubFetch(handler: (req: Request) => Response | Promise<Response>) {
		const seen: string[] = [];
		const seenBodies: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const req = input instanceof Request ? input : new Request(input as string, init);
				const host = new URL(req.url).host;
				expect(host).toBe(`api-library-${hostNo}.test`);
				seen.push(`${req.method} ${req.url.replace(`https://${host}`, "")}`);
				if (req.method === "PUT" || req.method === "POST") {
					seenBodies.push(await req.text().catch(() => ""));
				}
				return handler(req);
			}),
		);
		return { seen, seenBodies };
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("creates and deletes datasets through /v2", async () => {
		const { seen, seenBodies } = stubFetch(
			(req) =>
				req.method === "PUT"
					? new Response(JSON.stringify({ id: "d1", name: "Orders", data_json: "{}", revision: 1 }), { status: 201 })
					: new Response(null, { status: 204 }),
		);
		const { putRemoteDataset, deleteRemoteDataset } = await import("@/lib/share/client");

		const created = await putRemoteDataset({ id: "d1", name: "Orders", data_json: "{}" });
		expect(created).toMatchObject({ id: "d1", revision: 1 });
		expect(seen[0]).toBe("PUT /v2/datasets/d1");
		expect(seenBodies[0]).toContain('"dataJson":"{}"');

		await deleteRemoteDataset("d1");
		expect(seen[1]).toBe("DELETE /v2/datasets/d1");
	});

	it("creates and deletes profiles through /v2", async () => {
		const { seen, seenBodies } = stubFetch(
			(req) =>
				req.method === "PUT"
					? new Response(JSON.stringify({ id: "p1", template_id: "t1", printer_name: "e2e", settings_json: "{}", revision: 1 }), { status: 201 })
					: new Response(null, { status: 204 }),
		);
		const { putRemoteProfile, deleteRemoteProfile } = await import("@/lib/share/client");

		const created = await putRemoteProfile({ id: "p1", template_id: "t1", printer_name: "E2E", settings_json: "{}" });
		expect(created).toMatchObject({ printer_name: "e2e", revision: 1 });
		expect(seen[0]).toBe("PUT /v2/profiles/p1");
		expect(seenBodies[0]).toContain('"printer_name":"E2E"');

		await deleteRemoteProfile("p1");
		expect(seen[1]).toBe("DELETE /v2/profiles/p1");
	});

	it("sets and resets account preferences through /v2", async () => {
		const { seen, seenBodies } = stubFetch(
			(req) =>
				req.method === "PUT"
					? new Response(JSON.stringify({ key: "ui_density", value: "compact", revision: 2 }), { status: 200 })
					: new Response(null, { status: 204 }),
		);
		const { putRemoteSetting, deleteRemoteSetting } = await import("@/lib/share/client");

		const updated = await putRemoteSetting("ui_density", "compact");
		expect(updated).toMatchObject({ key: "ui_density", value: "compact", revision: 2 });
		expect(seen[0]).toBe("PUT /v2/settings/ui_density");
		expect(seenBodies[0]).toContain('"value":"compact"');

		await deleteRemoteSetting("ui_density");
		expect(seen[1]).toBe("DELETE /v2/settings/ui_density");
	});

	it("creates font metadata and reports readiness from the hash", async () => {
		stubFetch(
			() => new Response(JSON.stringify({ id: "f1", name: "Body", format: "", size_bytes: 0, sha256: "", revision: 1 }), { status: 201 }),
		);
		const { putRemoteFont, isFontReady } = await import("@/lib/share/client");

		const created = await putRemoteFont({ id: "f1", name: "Body" });
		expect(created).toMatchObject({ id: "f1", revision: 1 });
		expect(isFontReady(created)).toBe(false);
		expect(isFontReady({ sha256: "abc" })).toBe(true);
	});

	it("uploads font bytes as octet-stream outside JSON", async () => {
		const { seen } = stubFetch(
			(req) => {
				expect(req.headers.get("content-type")).toBe("application/octet-stream");
				return new Response(
					JSON.stringify({ id: "f1", name: "Body", format: "ttf", size_bytes: 12, sha256: "s", revision: 2 }),
					{ status: 200 },
				);
			},
		);
		const { uploadRemoteFontFile } = await import("@/lib/share/client");

		const meta = await uploadRemoteFontFile("f1", new Uint8Array([0, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]));
		expect(meta).toMatchObject({ format: "ttf", revision: 2 });
		expect(seen[0]).toBe("PUT /v2/fonts/f1/file");
	});

	it("downloads font bytes and verifies the ETag hash", async () => {
		const bytes = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0xaa, 0xbb]);
		const sha = createHash("sha256").update(bytes).digest("hex");
		stubFetch(
			() =>
				new Response(bytes as unknown as BodyInit, {
					status: 200,
					headers: { ETag: `"${sha}"`, "Content-Type": "application/octet-stream" },
				}),
		);
		const { downloadRemoteFontFile } = await import("@/lib/share/client");

		const file = await downloadRemoteFontFile("f1");
		expect([...file.bytes]).toEqual([...bytes]);
		expect(file.sha256).toBe(sha);
	});

	it("refuses a download whose content does not match the ETag", async () => {
		stubFetch(
			() =>
				new Response(new Uint8Array([1, 2, 3]) as unknown as BodyInit, {
					status: 200,
					headers: { ETag: '"deadbeef"' },
				}),
		);
		const { downloadRemoteFontFile } = await import("@/lib/share/client");

		await expect(downloadRemoteFontFile("f1")).rejects.toThrow(/SHA-256/);
	});

	it("deletes fonts through /v2", async () => {
		const { seen } = stubFetch(() => new Response(null, { status: 204 }));
		const { deleteRemoteFont } = await import("@/lib/share/client");

		await deleteRemoteFont("f1");
		expect(seen[0]).toBe("DELETE /v2/fonts/f1");
	});
});
