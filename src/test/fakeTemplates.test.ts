import { beforeEach, describe, expect, it } from "vitest";
import { createFakeCache } from "../../e2e/support/fakeAgent/cache.js";

// Fake template store (Phase 3): the same dirty-write and tombstone
// rules as the Rust commands, plus seed hydration and reload
// persistence for the F-series specs.

beforeEach(() => {
	localStorage.removeItem("fake-agent:templates");
	localStorage.removeItem("fake-agent:seed");
});

function seedLs(templates: unknown[]) {
	localStorage.setItem("fake-agent:seed", JSON.stringify({ settings: {}, templates }));
}

describe("fake template store", () => {
	it("hydrates the seed and persists it across reloads", () => {
		seedLs([{ name: "Seeded", server_id: "srv-1", html: "<p>s</p>" }]);
		const first = createFakeCache();
		expect(first.listTemplates()).toHaveLength(1);
		expect(first.listTemplates()[0]).toMatchObject({ name: "Seeded", remote_id: "srv-1" });

		// A reload (new cache, seed consumed) reads the persisted rows.
		const second = createFakeCache();
		expect(second.listTemplates()).toHaveLength(1);
		expect(second.listTemplates()[0]).toMatchObject({ name: "Seeded" });
	});

	it("creates dirty rows with fresh server ids and rejects blank/duplicate names", () => {
		const cache = createFakeCache();
		const row = cache.createTemplate({ name: "  Fresh  ", html: "<p>x</p>" });
		expect(row.sync_state).toBe("dirty");
		expect(typeof row.server_id).toBe("string");
		expect(cache.listDirty()).toHaveLength(1);
		expect(() => cache.createTemplate({ name: "" })).toThrow();
		expect(() => cache.createTemplate({ name: "fresh" })).toThrow(/already exists/);
	});

	it("marks edits dirty and hides tombstones from lists", () => {
		const cache = createFakeCache();
		const row = cache.createTemplate({ name: "T", html: "<p>1</p>" });
		cache.markPushed(row.server_id as string, 1);

		cache.createVersion(row.id, { html: "<p>2</p>", css: "" });
		expect(cache.listDirty().map((t) => t.id)).toEqual([row.id]);
		expect(cache.listVersions(row.id)[0]).toMatchObject({ version_no: 2, html: "<p>2</p>" });

		cache.updateTemplateMeta(row.id, { id: row.id, name: "T2", page_w_mm: 100, page_h_mm: 100 });
		expect(cache.getTemplate(row.id).name).toBe("T2");

		cache.deleteTemplate(row.id);
		expect(cache.listTemplates()).toHaveLength(0);
		expect(() => cache.getTemplate(row.id)).toThrow();
		expect(cache.listTombstoned()).toEqual([row.server_id]);
	});
});
