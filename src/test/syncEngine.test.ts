import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
import {
	drainUses,
	pull,
	pushDirty,
	pushTombstones,
	syncOnce,
	type EngineApi,
	type EngineCache,
} from "@/lib/sync/engine";

function conflict(): ApiError {
	return new ApiError({ code: "revision_conflict", message: "stale", requestId: "r", status: 409 });
}

function notFound(): ApiError {
	return new ApiError({ code: "not_found", message: "gone", requestId: "r", status: 404 });
}

function cache(over: Partial<EngineCache> = {}): EngineCache & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		getCursor: async () => "",
		listDirty: async () => [],
		listTombstoned: async () => [],
		listSynced: async () => [],
		applyChanges: async (changes, cursor) => {
			calls.push(`apply:${changes.length}:${cursor}`);
			return { applied_upserts: changes.filter((c) => c.op === "upsert").length, applied_deletes: 0, skipped_dirty: 0 };
		},
		markPushed: async () => {},
		markConflicted: async () => {},
		forgetTemplate: async () => true,
		listQueuedUses: async () => [],
		drainUse: async () => {},
		...over,
	};
}

describe("pull", () => {
	it("pages until has_more is false", async () => {
		const c = cache();
		const api: EngineApi = {
			fetchChanges: vi
				.fn()
				.mockResolvedValueOnce({
					changes: [{ seq: "1", entity: "template", op: "upsert", data: { id: "a" } }],
					next_cursor: "MQ==",
					has_more: true,
					reset: false,
				})
				.mockResolvedValueOnce({ changes: [], next_cursor: "Mg==", has_more: false, reset: false }),
			fetchTemplate: async () => ({ revision: 1 }),
			putTemplate: async () => ({ revision: 1 }),
			deleteTemplate: async () => {},
			postUse: async () => {},
		};
		const res = await pull(c, api);
		expect(res).toEqual({ pulled: 1, forgotten: 0 });
		expect(c.calls).toEqual(["apply:1:MQ==", "apply:0:Mg=="]);
	});

	it("restarts from scratch on reset and forgets unseen synced rows", async () => {
		const forgotten: string[] = [];
		const c = cache({
			getCursor: async () => "old",
			listSynced: async () => ["a", "b"],
			forgetTemplate: async (id) => {
				forgotten.push(id);
				return true;
			},
		});
		const api: EngineApi = {
			fetchChanges: vi
				.fn()
				.mockResolvedValueOnce({ changes: [], next_cursor: "", has_more: false, reset: true })
				.mockResolvedValueOnce({
					changes: [{ seq: "9", entity: "template", op: "upsert", data: { id: "a" } }],
					next_cursor: "OQ==",
					has_more: false,
					reset: false,
				}),
			fetchTemplate: async () => ({ revision: 1 }),
			putTemplate: async () => ({ revision: 1 }),
			deleteTemplate: async () => {},
			postUse: async () => {},
		};
		const res = await pull(c, api);
		expect(res).toEqual({ pulled: 1, forgotten: 1 });
		expect(forgotten).toEqual(["b"]);
	});
});

describe("pushDirty", () => {
	const row = (over: Record<string, unknown> = {}) => ({
		id: 7,
		server_id: "srv-1",
		name: "T",
		summary: "",
		page_w_mm: 210,
		page_h_mm: 297,
		readme: "",
		html: "<p></p>",
		css: "",
		base_revision: 3,
		...over,
	});

	it("sends if_revision for updates and marks pushed", async () => {
		const bodies: unknown[] = [];
		const marks: unknown[] = [];
		const c = cache({
			listDirty: async () => [row()],
			markPushed: async (id, rev) => {
				marks.push([id, rev]);
			},
		});
		const api: EngineApi = {
			fetchChanges: async () => ({ changes: [], next_cursor: "", has_more: false, reset: false }),
				fetchTemplate: async () => ({ revision: 1 }),
			putTemplate: async (id, body) => {
				bodies.push([id, body]);
				return { revision: 4 };
			},
			deleteTemplate: async () => {},
			postUse: async () => {},
		};
		const res = await pushDirty(c, api);
		expect(res).toEqual({ pushed: 1, conflicts: [] });
		expect(bodies).toEqual([["srv-1", expect.objectContaining({ if_revision: 3 })]]);
		expect(marks).toEqual([["srv-1", 4]]);
	});

	it("creates without if_revision and marks the fresh id pushed", async () => {
		const bodies: unknown[] = [];
		const c = cache({ listDirty: async () => [row({ server_id: null, base_revision: null })] });
		const api: EngineApi = {
			fetchChanges: async () => ({ changes: [], next_cursor: "", has_more: false, reset: false }),
				fetchTemplate: async () => ({ revision: 1 }),
			putTemplate: async (id, body) => {
				bodies.push(body);
				expect(typeof id).toBe("string");
				return { revision: 1 };
			},
			deleteTemplate: async () => {},
			postUse: async () => {},
		};
		await pushDirty(c, api);
		expect(bodies[0]).not.toHaveProperty("if_revision");
	});

	it("holds unpushed rows while adoption is pending", async () => {
		const puts: unknown[] = [];
		const cacheWithHold = (hold: boolean) =>
			cache({
				listDirty: async () => [
					row({ server_id: "a", base_revision: null }),
					row({ server_id: "b", id: 8, base_revision: 1 }),
				],
				isAdoptionPending: async () => hold,
			});
		const api: EngineApi = {
			fetchChanges: async () => ({ changes: [], next_cursor: "", has_more: false, reset: false }),
			fetchTemplate: async () => ({ revision: 1 }),
			putTemplate: async (id, body) => {
				puts.push([id, body]);
				return { revision: 2 };
			},
			deleteTemplate: async () => {},
			postUse: async () => {},
		};
		const held = await pushDirty(cacheWithHold(true), api);
		expect(held).toEqual({ pushed: 1, conflicts: [] });
		expect(puts).toEqual([["b", expect.objectContaining({ if_revision: 1 })]]);

		const released = await pushDirty(cacheWithHold(false), api);
		expect(released).toEqual({ pushed: 2, conflicts: [] });
	});

	it("retries a 428 as an update against the stored revision", async () => {
		const puts: unknown[] = [];
		const marks: unknown[] = [];
		const c = cache({
			listDirty: async () => [row({ server_id: "a", base_revision: null })],
			markPushed: async (id, rev) => {
				marks.push([id, rev]);
			},
		});
		const api: EngineApi = {
			fetchChanges: async () => ({ changes: [], next_cursor: "", has_more: false, reset: false }),
			fetchTemplate: async () => ({ revision: 7 }),
			putTemplate: async (_id, body) => {
				puts.push(body);
				if (!("if_revision" in (body as Record<string, unknown>))) {
					throw new ApiError({ code: "revision_required", message: "Update needs if_revision", requestId: "r", status: 428 });
				}
				return { revision: 8 };
			},
			deleteTemplate: async () => {},
			postUse: async () => {},
		};
		const res = await pushDirty(c, api);
		expect(res).toEqual({ pushed: 1, conflicts: [] });
		expect(puts).toHaveLength(2);
		expect((puts[1] as Record<string, unknown>)["if_revision"]).toBe(7);
		expect(marks).toEqual([["a", 8]]);
	});

	it("marks 409 rows conflicted and keeps going, but throws on other errors", async () => {
		const conflicted: string[] = [];
		const c = cache({
			listDirty: async () => [row({ server_id: "a" }), row({ server_id: "b", id: 8 })],
			markConflicted: async (id) => {
				conflicted.push(id);
			},
			markPushed: async () => {},
		});
		const api: EngineApi = {
			fetchChanges: async () => ({ changes: [], next_cursor: "", has_more: false, reset: false }),
				fetchTemplate: async () => ({ revision: 1 }),
			putTemplate: async (id) => {
				if (id === "a") throw conflict();
				return { revision: 2 };
			},
			deleteTemplate: async () => {},
			postUse: async () => {},
		};
		const res = await pushDirty(c, api);
		expect(res).toEqual({ pushed: 1, conflicts: ["a"] });
		expect(conflicted).toEqual(["a"]);

		const failing: EngineApi = {
			...api,
			putTemplate: async () => {
				throw new Error("boom");
			},
		};
		await expect(pushDirty(c, failing)).rejects.toThrow("boom");
	});
});

describe("pushTombstones", () => {
	it("deletes and forgets; a 404 counts as confirmed", async () => {
		const forgotten: string[] = [];
		const c = cache({
			listTombstoned: async () => ["a", "b"],
			forgetTemplate: async (id) => {
				forgotten.push(id);
				return true;
			},
		});
		const api: EngineApi = {
			fetchChanges: async () => ({ changes: [], next_cursor: "", has_more: false, reset: false }),
				fetchTemplate: async () => ({ revision: 1 }),
			putTemplate: async () => ({ revision: 1 }),
			deleteTemplate: async (id) => {
				if (id === "b") throw notFound();
			},
			postUse: async () => {},
		};
		expect(await pushTombstones(c, api)).toBe(2);
		expect(forgotten).toEqual(["a", "b"]);
	});

	it("throws on non-404 failures without forgetting", async () => {
		const forgotten: string[] = [];
		const c = cache({
			listTombstoned: async () => ["a"],
			forgetTemplate: async (id) => {
				forgotten.push(id);
				return true;
			},
		});
		const api: EngineApi = {
			fetchChanges: async () => ({ changes: [], next_cursor: "", has_more: false, reset: false }),
				fetchTemplate: async () => ({ revision: 1 }),
			putTemplate: async () => ({ revision: 1 }),
			deleteTemplate: async () => {
				throw new Error("boom");
			},
			postUse: async () => {},
		};
		await expect(pushTombstones(c, api)).rejects.toThrow("boom");
		expect(forgotten).toEqual([]);
	});
});

describe("drainUses", () => {
	it("posts each queued count and drains it", async () => {
		const posted: unknown[] = [];
		const drained: unknown[] = [];
		const c = cache({
			listQueuedUses: async () => [
				{ server_template_id: "a", count: 3 },
				{ server_template_id: "b", count: 1 },
			],
			drainUse: async (id, count) => {
				drained.push([id, count]);
			},
		});
		const api: EngineApi = {
			fetchChanges: async () => ({ changes: [], next_cursor: "", has_more: false, reset: false }),
				fetchTemplate: async () => ({ revision: 1 }),
			putTemplate: async () => ({ revision: 1 }),
			deleteTemplate: async () => {},
			postUse: async (id, count) => {
				posted.push([id, count]);
			},
		};
		expect(await drainUses(c, api)).toBe(4);
		expect(posted).toEqual([
			["a", 3],
			["b", 1],
		]);
		expect(drained).toEqual([
			["a", 3],
			["b", 1],
		]);
	});
});

describe("syncOnce", () => {
	it("pulls, confirms deletes, pushes edits and drains uses in order", async () => {
		const order: string[] = [];
		const c = cache({
			getCursor: async () => "",
			applyChanges: async () => {
				order.push("pull");
				return { applied_upserts: 1, applied_deletes: 0, skipped_dirty: 0 };
			},
			listTombstoned: async () => [],
			listDirty: async () => [],
			listQueuedUses: async () => [],
		});
		const api: EngineApi = {
			fetchChanges: async () => {
				order.push("fetch");
				return { changes: [], next_cursor: "MQ==", has_more: false, reset: false };
			},
			fetchTemplate: async () => ({ revision: 1 }),
			putTemplate: async () => ({ revision: 1 }),
			deleteTemplate: async () => {},
			postUse: async () => {},
		};
		const res = await syncOnce(c, api);
		expect(order).toEqual(["fetch", "pull"]);
		expect(res).toEqual({ pulled: 1, pushed: 0, conflicts: [], usesSent: 0, forgotten: 0 });
	});
});
