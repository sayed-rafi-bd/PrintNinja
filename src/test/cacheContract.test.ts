import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeCache } from "../../e2e/support/fakeAgent/cache.js";
import { getSetting, setSetting } from "../../e2e/support/fakeAgent/store.js";

// The other half of the sync-cache contract (REFACTORING.md section 11,
// Phase 3): the same tests/fixtures/cache_cases.json that the Rust suite
// runs, executed here against the TypeScript fake agent. A behavior that
// differs between the two fails in one of the two suites.
//
// The fake persists rows to localStorage for reload survival; each case
// gets a fresh cache, so the persisted state is cleared first.
beforeEach(() => {
	localStorage.removeItem("fake-agent:templates");
	localStorage.removeItem("fake-agent:datasets");
	localStorage.removeItem("fake-agent:profiles");
	localStorage.removeItem("fake-agent:fonts");
	localStorage.removeItem("fake-agent:printers");
	localStorage.removeItem("fake-agent:dirty-settings");
	localStorage.removeItem("fake-agent:seed");
});

interface FixtureTemplate {
	name?: string;
	server_id: string;
	sync_state?: string;
	server_revision?: number;
	html?: string;
	css?: string;
	published_at?: string | null;
	kind?: string;
	owner_handle?: string | null;
}

interface FixtureChange {
	seq: number;
	entity: string;
	op: string;
	data?: Record<string, unknown>;
	id?: string;
}

interface FixtureDataset {
	server_id: string;
	name?: string;
	data_json?: string;
	sync_state?: string;
	server_revision?: number;
}

interface FixtureProfile {
	server_id: string;
	template_server_id?: string;
	printer_name?: string;
	settings_json?: string;
	sync_state?: string;
	server_revision?: number;
}

interface FixtureSetting {
	key: string;
	value?: string;
	dirty?: "dirty" | "deleted_pending";
}

interface FixtureFont {
	server_id: string;
	family?: string;
	sha256?: string;
	sync_state?: string;
	server_revision?: number;
}

interface FixtureCase {
	name: string;
	given: {
		templates: FixtureTemplate[];
		datasets?: FixtureDataset[];
		profiles?: FixtureProfile[];
		settings?: FixtureSetting[];
		fonts?: FixtureFont[];
		sync_state: { cursor?: string };
	};
	changes: FixtureChange[];
	new_cursor: string;
	expect: {
		templates: Record<string, unknown>[];
		datasets?: Record<string, unknown>[];
		profiles?: Record<string, unknown>[];
		settings?: Record<string, unknown>[];
		fonts?: Record<string, unknown>[];
		gone: string[];
		gone_datasets?: string[];
		gone_profiles?: string[];
		gone_settings?: string[];
		gone_fonts?: string[];
		sync_cursor: string;
		report: { applied_upserts: number; applied_deletes: number; skipped_dirty: number } | null;
		error?: boolean;
	};
}

function loadCases(): FixtureCase[] {
	const here = dirname(fileURLToPath(import.meta.url));
	const raw = readFileSync(join(here, "..", "..", "src-tauri", "tests", "fixtures", "cache_cases.json"), "utf8");
	return (JSON.parse(raw) as { cases: FixtureCase[] }).cases;
}

function rowByServerId(cache: ReturnType<typeof createFakeCache>, serverId: string) {
	for (const row of cache._store.templates.values()) {
		if (row.server_id === serverId) {
			return row;
		}
	}
	return undefined;
}

describe("cache cases match the fake agent", () => {
	for (const kase of loadCases()) {
		it(kase.name, () => {
			const cache = createFakeCache();

			for (const t of kase.given.templates) {
				const id = cache._store.nextId();
				cache._store.templates.set(id, {
					id,
					server_id: t.server_id,
					name: t.name ?? "T",
					summary: "",
					page_w: 210,
					page_h: 297,
					orientation: "portrait",
					readme: "",
					published_at: t.published_at ?? null,
					updated_at: new Date().toISOString(),
					server_revision: t.server_revision ?? 1,
					base_revision: t.server_revision ?? 1,
					sync_state: (t.sync_state ?? "synced") as "synced" | "dirty" | "deleted_pending" | "conflict",
					kind: (t.kind ?? "own") as "own" | "saved",
					owner_handle: t.owner_handle ?? null,
					synced_at: null,
					versions: [{ version_no: 1, html: t.html ?? "<p></p>", css: t.css ?? "", created_by: "manual" }],
				});
			}
			for (const d of kase.given.datasets ?? []) {
				const id = cache.library._store.nextDatasetId();
				cache.library._store.datasets.set(id, {
					id,
					server_id: d.server_id,
					name: d.name ?? "D",
					data_json: d.data_json ?? "{}",
					server_revision: d.server_revision ?? 1,
					base_revision: (d.sync_state ?? "synced") === "synced" ? (d.server_revision ?? 1) : null,
					sync_state: (d.sync_state ?? "synced") as "synced" | "dirty" | "deleted_pending" | "conflict",
					updated_at: new Date().toISOString(),
				});
			}
			for (const p of kase.given.profiles ?? []) {
				const id = cache.library._store.nextProfileId();
				cache.library._store.profiles.set(id, {
					id,
					server_id: p.server_id,
					template_server_id: p.template_server_id ?? "tpl-1",
					printer_name: p.printer_name ?? "e2e",
					settings_json: p.settings_json ?? "{}",
					server_revision: p.server_revision ?? 1,
					base_revision: (p.sync_state ?? "synced") === "synced" ? (p.server_revision ?? 1) : null,
					sync_state: (p.sync_state ?? "synced") as "synced" | "dirty" | "deleted_pending" | "conflict",
					updated_at: new Date().toISOString(),
				});
			}
			for (const s of kase.given.settings ?? []) {
				setSetting(s.key, s.value ?? "");
				if (s.dirty) {
					cache.library._store.dirtySettings.set(s.key, s.dirty);
				}
			}
			for (const f of kase.given.fonts ?? []) {
				const id = cache.library._store.nextFontId();
				cache.library._store.fonts.set(id, {
					id,
					server_id: f.server_id,
					family: f.family ?? "Body",
					format: "ttf",
					sha256: f.sha256 ?? "",
					size_bytes: 0,
					server_revision: f.server_revision ?? 1,
					base_revision: (f.sync_state ?? "synced") === "synced" ? (f.server_revision ?? 1) : null,
					sync_state: (f.sync_state ?? "synced") as "synced" | "dirty" | "deleted_pending" | "conflict",
					updated_at: new Date().toISOString(),
					bytes: null,
				});
			}
			if (kase.given.sync_state.cursor) {
				cache._store.sync.cursor = kase.given.sync_state.cursor;
			}

			let report: { applied_upserts: number; applied_deletes: number; skipped_dirty: number } | null = null;
			let error: unknown = null;
			try {
				report = cache.applyChanges(
					kase.changes.map((c) => ({
						seq: c.seq,
						entity: c.entity,
						op: c.op,
						...(c.data !== undefined ? { data: c.data } : {}),
						...(c.id !== undefined ? { id: c.id } : {}),
					})),
					kase.new_cursor,
				);
			} catch (e) {
				error = e;
			}

			if (kase.expect.error) {
				expect(error, `case '${kase.name}' must fail`).not.toBeNull();
				expect(cache.getSyncState().cursor).toBe(kase.given.sync_state.cursor ?? "");
				for (const gone of kase.expect.gone) {
					expect(rowByServerId(cache, gone), `case '${kase.name}': ${gone} written despite error`).toBeUndefined();
				}
				const libGone = (rows: Array<{ server_id: string }>, key: string) =>
					expect(rows.find((r) => r.server_id === key), `case '${kase.name}': ${key} written despite error`).toBeUndefined();
				for (const key of kase.expect.gone_datasets ?? []) {
					libGone([...cache.library._store.datasets.values()], key);
				}
				for (const key of kase.expect.gone_profiles ?? []) {
					libGone([...cache.library._store.profiles.values()], key);
				}
				for (const key of kase.expect.gone_fonts ?? []) {
					libGone([...cache.library._store.fonts.values()], key);
				}
				for (const key of kase.expect.gone_settings ?? []) {
					expect(getSetting(key), `case '${kase.name}': setting ${key} written despite error`).toBeNull();
				}
				return;
			}
			expect(error).toBeNull();

			expect(report).toEqual(kase.expect.report);
			for (const wanted of kase.expect.templates) {
				const serverId = wanted["server_id"] as string;
				const actual = rowByServerId(cache, serverId);
				expect(actual, `case '${kase.name}': missing row ${serverId}`).toBeDefined();
				const head = actual!.versions[actual!.versions.length - 1];
				const flat: Record<string, unknown> = {
					name: actual!.name,
					sync_state: actual!.sync_state,
					server_revision: actual!.server_id === undefined ? undefined : actual!.server_revision,
					html: head?.html,
					published_at: actual!.published_at,
					kind: actual!.kind,
					owner_handle: actual!.owner_handle,
				};
				for (const [key, value] of Object.entries(wanted)) {
					if (key === "server_id") {
						continue;
					}
					expect(flat[key], `case '${kase.name}' field ${key} of ${serverId}`).toEqual(value);
				}
			}
			for (const gone of kase.expect.gone) {
				expect(rowByServerId(cache, gone), `case '${kase.name}': ${gone} still present`).toBeUndefined();
			}
			for (const wanted of kase.expect.datasets ?? []) {
				const serverId = wanted["server_id"] as string;
				const actual = cache.library._store.datasets
					? [...cache.library._store.datasets.values()].find((r) => r.server_id === serverId)
					: undefined;
				expect(actual, `case '${kase.name}': missing dataset ${serverId}`).toBeDefined();
				for (const [key, value] of Object.entries(wanted)) {
					if (key === "server_id") continue;
					expect(actual?.[key as keyof typeof actual], `case '${kase.name}' dataset field ${key} of ${serverId}`).toEqual(value);
				}
			}
			for (const wanted of kase.expect.profiles ?? []) {
				const serverId = wanted["server_id"] as string;
				const actual = [...cache.library._store.profiles.values()].find((r) => r.server_id === serverId);
				expect(actual, `case '${kase.name}': missing profile ${serverId}`).toBeDefined();
				for (const [key, value] of Object.entries(wanted)) {
					if (key === "server_id") continue;
					expect(actual?.[key as keyof typeof actual], `case '${kase.name}' profile field ${key} of ${serverId}`).toEqual(value);
				}
			}
			for (const wanted of kase.expect.settings ?? []) {
				const key = wanted["key"] as string;
				const actual = getSetting(key);
				expect(actual, `case '${kase.name}': missing setting ${key}`).not.toBeNull();
				if (wanted["value"] !== undefined) {
					expect(actual, `case '${kase.name}' setting ${key}`).toEqual(wanted["value"]);
				}
			}
			for (const wanted of kase.expect.fonts ?? []) {
				const serverId = wanted["server_id"] as string;
				const actual = [...cache.library._store.fonts.values()].find((r) => r.server_id === serverId);
				expect(actual, `case '${kase.name}': missing font ${serverId}`).toBeDefined();
				for (const [key, value] of Object.entries(wanted)) {
					if (key === "server_id") continue;
					expect(actual?.[key as keyof typeof actual], `case '${kase.name}' font field ${key} of ${serverId}`).toEqual(value);
				}
			}
			const goneBy = (rows: Array<{ server_id: string }>, key: string) =>
				expect(rows.find((r) => r.server_id === key), `case '${kase.name}': ${key} still present`).toBeUndefined();
			for (const key of kase.expect.gone_datasets ?? []) {
				goneBy([...cache.library._store.datasets.values()], key);
			}
			for (const key of kase.expect.gone_profiles ?? []) {
				goneBy([...cache.library._store.profiles.values()], key);
			}
			for (const key of kase.expect.gone_fonts ?? []) {
				goneBy([...cache.library._store.fonts.values()], key);
			}
			for (const key of kase.expect.gone_settings ?? []) {
				expect(getSetting(key), `case '${kase.name}': setting ${key} still present`).toBeNull();
			}
			expect(cache.getSyncState().cursor).toBe(kase.expect.sync_cursor);
		});
	}
});

describe("cache ops parity", () => {
	function seeded() {
		const cache = createFakeCache();
		const seed = (
			server_id: string,
			over: Partial<{ sync_state: "synced" | "dirty" | "deleted_pending" | "conflict"; server_revision: number; base_revision: number | null; html: string; published_at: string | null }> = {},
		) => {
			const id = cache._store.nextId();
			cache._store.templates.set(id, {
				id,
				server_id,
				name: "T",
				summary: "",
				page_w: 210,
				page_h: 297,
				orientation: "portrait",
				readme: "",
				published_at: over.published_at ?? null,
				updated_at: new Date().toISOString(),
				server_revision: over.server_revision ?? 1,
				base_revision: over.base_revision === undefined ? (over.server_revision ?? 1) : over.base_revision,
				sync_state: over.sync_state ?? "synced",
				kind: "own",
				owner_handle: null,
				synced_at: null,
				versions: [{ version_no: 1, html: over.html ?? "<p></p>", css: "", created_by: "manual" as const }],
			});
			return id;
		};
		return { cache, seed };
	}

	it("marks conflicts and resolves both ways", () => {
		const { cache, seed } = seeded();
		seed("srv-c", { server_revision: 5 });

		cache.markConflicted("srv-c");
		expect(cache._store.templates.get(1)?.sync_state).toBe("conflict");
		expect(() => cache.markConflicted("srv-nope")).toThrow();

		// Only conflicted rows resolve.
		expect(() =>
			cache.resolveConflict("srv-c", "theirs", { id: "srv-c", name: "C" } as never),
		).not.toThrow();
		// Unknown rows and non-conflicted rows refuse.
		expect(() => cache.resolveConflict("srv-nope", "mine")).toThrow();
		cache.markConflicted("srv-c");
		expect(() => cache.resolveConflict("srv-c", "mine", undefined)).not.toThrow();
		expect(cache._store.templates.get(1)?.sync_state).toBe("dirty");

		// Rebasing moves both revisions so the next push matches.
		cache.markConflicted("srv-c");
		cache.resolveConflict("srv-c", "mine", undefined, 9);
		expect(cache._store.templates.get(1)).toMatchObject({ sync_state: "dirty", server_revision: 9, base_revision: 9 });

		// Theirs overwrites content and marks synced at the given revision.
		cache.markConflicted("srv-c");
		cache.resolveConflict("srv-c", "theirs", {
			id: "srv-c",
			name: "C",
			summary: "",
			page_w_mm: 210,
			page_h_mm: 297,
			body: "<p>server</p>",
			css: "",
			readme: "",
			revision: 6,
			published_at: null,
			updated_at: "2026-10-20T00:00:00Z",
		});
		const row = cache._store.templates.get(1)!;
		expect(row.sync_state).toBe("synced");
		expect(row.server_revision).toBe(6);
		expect(row.versions[row.versions.length - 1]).toMatchObject({ html: "<p>server</p>" });
	});

	it("queues uses, drains by negative delta, and clears the account", () => {
		const { cache, seed } = seeded();
		seed("srv-q", {});

		expect(cache.queueUse("srv-q", 3)).toBe(3);
		expect(cache.queueUse("srv-q", 2)).toBe(5);
		expect(cache.queueUse("srv-other", 1)).toBe(1);
		expect(cache.listQueuedUses()).toEqual([
			{ server_template_id: "srv-other", count: 1 },
			{ server_template_id: "srv-q", count: 5 },
		]);

		expect(cache.queueUse("srv-q", -5)).toBe(0);
		expect(cache.listQueuedUses()).toEqual([{ server_template_id: "srv-other", count: 1 }]);

		expect(cache.clearAccount()).toBe(1);
		expect(cache.listQueuedUses()).toEqual([]);
		expect(cache._store.templates.size).toBe(0);
		expect(cache.getSyncState()).toMatchObject({ cursor: "", account_handle: null });
	});

	it("lists tombstoned/synced rows and forgets tombstones", () => {
		const { cache, seed } = seeded();
		seed("srv-keep", {});
		seed("srv-gone", { sync_state: "deleted_pending" });

		expect([...cache.listTombstoned()].sort()).toEqual(["srv-gone"]);
		expect(cache.listSynced()).toEqual(["srv-keep"]);

		expect(cache.forgetTemplate("srv-gone")).toBe(true);
		expect(cache.forgetTemplate("srv-gone")).toBe(false);
		expect(cache.listTombstoned()).toEqual([]);
	});

	it("lists only conflicted rows in id order", () => {
		const { cache, seed } = seeded();
		const a = seed("srv-a", {});
		seed("srv-b", {});
		const c = seed("srv-c", {});
		cache.markConflicted("srv-c");
		cache.markConflicted("srv-a");

		expect(cache.listConflicted()).toEqual([
			{ id: a, server_id: "srv-a", name: "T" },
			{ id: c, server_id: "srv-c", name: "T" },
		]);
	});

	it("skips pulls for conflicted and tombstoned rows", () => {
		const { cache, seed } = seeded();
		seed("srv-k", {});
		for (const state of ["conflict", "deleted_pending"] as const) {
			cache._store.templates.get(1)!.sync_state = state;
			const report = cache.applyChanges(
				[
					{
						seq: 1,
						entity: "template",
						op: "upsert",
						data: {
							id: "srv-k",
							name: "K",
							page_w_mm: 210,
							page_h_mm: 297,
							body: "<p>x</p>",
							revision: 2,
							updated_at: "2026-10-20T00:00:00Z",
						},
					},
				],
				"MQ==",
			);
			expect(report, `state ${state}`).toEqual({ applied_upserts: 0, applied_deletes: 0, skipped_dirty: 1 });
			expect(cache._store.templates.get(1)?.sync_state).toBe(state);
		}
	});
});

describe("first-sync adoption", () => {
	function seeded() {
		const cache = createFakeCache();
		return { cache };
	}

	function upsertBody(id: string, body: string, revision = 2) {
		return {
			id,
			name: "T",
			summary: "",
			page_w_mm: 210,
			page_h_mm: 297,
			body,
			css: "",
			readme: "",
			revision,
			published_at: null,
			updated_at: "2026-10-21T00:00:00Z",
		};
	}

	it("adopts matching content with no new version", () => {
		const { cache } = seeded();
		const id = cache._store.nextId();
		cache._store.templates.set(id, {
			id,
			server_id: "srv-m",
			name: "T",
			summary: "",
			page_w: 210,
			page_h: 297,
			orientation: "portrait",
			readme: "",
			published_at: null,
			updated_at: new Date().toISOString(),
			server_revision: 1,
			base_revision: null,
			sync_state: "synced",
			kind: "own",
			owner_handle: null,
			synced_at: null,
			versions: [{ version_no: 1, html: "<p>same</p>", css: "", created_by: "manual" as const }],
		});

		const report = cache.applyChanges(
			[{ seq: 1, entity: "template", op: "upsert", data: upsertBody("srv-m", "<p>same</p>") }],
			"MQ==",
		);
		expect(report).toEqual({ applied_upserts: 1, applied_deletes: 0, skipped_dirty: 0 });
		expect(cache._store.templates.get(id)).toMatchObject({
			sync_state: "synced",
			server_revision: 2,
			base_revision: 2,
		});
		expect(cache._store.templates.get(id)?.versions).toHaveLength(1);
	});

	it("conflicts instead of overwriting differences", () => {
		const { cache } = seeded();
		const id = cache._store.nextId();
		cache._store.templates.set(id, {
			id,
			server_id: "srv-m",
			name: "T",
			summary: "",
			page_w: 210,
			page_h: 297,
			orientation: "portrait",
			readme: "",
			published_at: null,
			updated_at: new Date().toISOString(),
			server_revision: 1,
			base_revision: null,
			sync_state: "synced",
			kind: "own",
			owner_handle: null,
			synced_at: null,
			versions: [{ version_no: 1, html: "<p>local</p>", css: "", created_by: "manual" as const }],
		});

		const report = cache.applyChanges(
			[{ seq: 1, entity: "template", op: "upsert", data: upsertBody("srv-m", "<p>server</p>") }],
			"MQ==",
		);
		expect(report).toEqual({ applied_upserts: 0, applied_deletes: 0, skipped_dirty: 1 });
		const row = cache._store.templates.get(id)!;
		expect(row.sync_state).toBe("conflict");
		expect(row.versions[row.versions.length - 1]?.html).toBe("<p>local</p>");
	});
});
