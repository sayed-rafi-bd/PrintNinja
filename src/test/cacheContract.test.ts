import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFakeCache } from "../../e2e/support/fakeAgent/cache.js";

// The other half of the sync-cache contract (REFACTORING.md section 11,
// Phase 3): the same tests/fixtures/cache_cases.json that the Rust suite
// runs, executed here against the TypeScript fake agent. A behavior that
// differs between the two fails in one of the two suites.

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

interface FixtureCase {
	name: string;
	given: { templates: FixtureTemplate[]; sync_state: { cursor?: string } };
	changes: FixtureChange[];
	new_cursor: string;
	expect: {
		templates: Record<string, unknown>[];
		gone: string[];
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
			expect(cache.getSyncState().cursor).toBe(kase.expect.sync_cursor);
		});
	}
});
