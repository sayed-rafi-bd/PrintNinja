import { describe, expect, it, vi } from "vitest";
import { ApiError, storedRevision } from "@/lib/api/errors";
import {
	downloadFontFiles,
	drainUses,
	pull,
	pushDirty,
	pushLibraryDirty,
	pushLibraryTombstones,
	pushTombstones,
	syncOnce,
	type EngineApi,
	type EngineCache,
	type LibraryApi,
	type LibraryCache,
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
		expect(res).toEqual({ pulled: 1, pushed: 0, conflicts: [], usesSent: 0, forgotten: 0, fontsDownloaded: 0, fontsFailed: 0 });
	});
});

function revisionConflict(stored: number): ApiError {
	return new ApiError({
		code: "revision_conflict",
		message: "stale",
		requestId: "r",
		status: 409,
		details: [{ path: "revision", message: String(stored) }],
	});
}

function revisionRequired(): ApiError {
	return new ApiError({ code: "revision_required", message: "needs revision", requestId: "r", status: 428 });
}

function libraryCache(over: Partial<LibraryCache> = {}): LibraryCache {
	return {
		listDirtyDatasets: async () => [],
		listDirtyProfiles: async () => [],
		listDirtySettings: async () => [],
		listDirtyFonts: async () => [],
		listTombstonedDatasets: async () => [],
		listTombstonedProfiles: async () => [],
		listTombstonedSettings: async () => [],
		listTombstonedFonts: async () => [],
		listSyncedDatasets: async () => [],
		listSyncedProfiles: async () => [],
		listSyncedSettings: async () => [],
		listSyncedFonts: async () => [],
		markDatasetPushed: async () => {},
		markProfilePushed: async () => {},
		markSettingPushed: async () => {},
		markFontPushed: async () => {},
		forgetDataset: async () => true,
		forgetProfile: async () => true,
		forgetSetting: async () => true,
		forgetFont: async () => true,
		readFontFile: async () => [],
		downloadPendingFonts: async () => ({ downloaded: 0, failed: 0 }),
		...over,
	};
}

function libraryApi(over: Partial<LibraryApi> = {}): LibraryApi {
	return {
		putDataset: async () => ({ revision: 1 }),
		deleteDataset: async () => {},
		putProfile: async () => ({ revision: 1 }),
		deleteProfile: async () => {},
		putSetting: async () => ({}),
		deleteSetting: async () => {},
		putFont: async () => ({ revision: 1 }),
		putFontFile: async () => ({ revision: 2 }),
		deleteFont: async () => {},
		...over,
	};
}

describe("storedRevision", () => {
	it("reads the revision from 409 details", () => {
		expect(storedRevision(revisionConflict(7))).toBe(7);
		expect(storedRevision(revisionRequired())).toBeNull;
		expect(storedRevision(new Error("nope"))).toBeNull;
		expect(
			storedRevision(new ApiError({ code: "revision_conflict", message: "x", requestId: "r", status: 409 })),
		).toBeNull;
	});
});

describe("pushLibraryTombstones", () => {
	it("deletes every entity and forgets on 204 or 404", async () => {
		const order: string[] = [];
		const c = libraryCache({
			listTombstonedDatasets: async () => ["d1"],
			listTombstonedProfiles: async () => ["p1"],
			listTombstonedSettings: async () => ["ui_density"],
			listTombstonedFonts: async () => ["f1"],
			forgetDataset: async (id) => void order.push(`forget-dataset:${id}`),
			forgetProfile: async (id) => void order.push(`forget-profile:${id}`),
			forgetSetting: async (key) => void order.push(`forget-setting:${key}`),
			forgetFont: async (id) => void order.push(`forget-font:${id}`),
		});
		const api = libraryApi({
			deleteDataset: async (id) => void order.push(`delete-dataset:${id}`),
			deleteProfile: async () => {
				throw notFound();
			},
			deleteSetting: async (key) => void order.push(`delete-setting:${key}`),
			deleteFont: async (id) => void order.push(`delete-font:${id}`),
		});
		const done = await pushLibraryTombstones(c, api);
		expect(done).toBe(4);
		expect(order).toContain("forget-profile:p1");
	});
});

describe("pushLibraryDirty", () => {
	it("creates datasets without if_revision and updates with the base", async () => {
		const puts: Array<[string, Record<string, unknown>]> = [];
		const marks: Array<[string, number]> = [];
		const c = libraryCache({
			listDirtyDatasets: async () => [
				{ server_id: "new", name: "N", data_json: "{}", base_revision: null },
				{ server_id: "old", name: "O", data_json: "{}", base_revision: 3 },
			],
			markDatasetPushed: async (id, revision) => void marks.push([id, revision]),
		});
		const api = libraryApi({
			putDataset: async (id, body) => {
				puts.push([id, body as Record<string, unknown>]);
				return { revision: (body.if_revision as number | undefined) === 3 ? 4 : 1 };
			},
		});
		const pushed = await pushLibraryDirty(c, api);
		expect(pushed).toBe(2);
		expect(puts[0]?.[1]).not.toHaveProperty("if_revision");
		expect(puts[1]?.[1]).toMatchObject({ if_revision: 3 });
		expect(marks).toEqual([
			["new", 1],
			["old", 4],
		]);
	});

	it("retries a lost create with revision 1 and rebases a 409 from details", async () => {
		const c = libraryCache({
			listDirtyDatasets: async () => [{ server_id: "lost", name: "L", data_json: "{}", base_revision: null }],
			markDatasetPushed: async () => {},
		});
		const api = libraryApi({
			putDataset: vi
				.fn()
				.mockRejectedValueOnce(revisionRequired())
				.mockResolvedValueOnce({ revision: 2 }),
		});
		await pushLibraryDirty(c, api);
		expect(api.putDataset).toHaveBeenCalledTimes(2);
		// The retry carries the first revision: only a lost create can own the id.
		expect(api.putDataset).toHaveBeenLastCalledWith("lost", expect.objectContaining({ if_revision: 1 }));

		// Stale base: the details carry the fresh revision, no fetch needed.
		const bodies: Array<Record<string, unknown>> = [];
		const c2 = libraryCache({
			listDirtyProfiles: async () => [
				{ server_id: "p", template_id: "t", printer_name: "e", settings_json: "{}", base_revision: 1 },
			],
			markProfilePushed: async () => {},
		});
		const api2 = libraryApi({
			putProfile: async (_id, body) => {
				bodies.push(body as Record<string, unknown>);
				if (body.if_revision === 1) throw revisionConflict(5);
				return { revision: 6 };
			},
		});
		const pushed = await pushLibraryDirty(c2, api2);
		expect(pushed).toBe(1);
		expect(bodies).toEqual([
			expect.objectContaining({ if_revision: 1 }),
			expect.objectContaining({ if_revision: 5 }),
		]);
	});

	it("puts settings and deletes reset tombstones, tolerating 404", async () => {
		const calls: string[] = [];
		const c = libraryCache({
			listDirtySettings: async () => [
				{ key: "ui_density", value: "compact", tombstone: false },
				{ key: "brand_name", value: "", tombstone: true },
			],
			markSettingPushed: async (key) => void calls.push(`marked:${key}`),
		});
		const api = libraryApi({
			putSetting: async (key, value) => void calls.push(`put:${key}=${value}`),
			deleteSetting: async () => {
				throw notFound();
			},
		});
		const pushed = await pushLibraryDirty(c, api);
		expect(pushed).toBe(2);
		expect(calls).toEqual(["put:ui_density=compact", "marked:ui_density", "marked:brand_name"]);
	});

	it("pushes font metadata then bytes and marks the file revision", async () => {
		const calls: string[] = [];
		const c = libraryCache({
			listDirtyFonts: async () => [{ server_id: "f", name: "Body", base_revision: null }],
			readFontFile: async () => [0, 1, 0, 0],
			markFontPushed: async (id, revision) => void calls.push(`marked:${id}@${revision}`),
		});
		const api = libraryApi({
			putFont: async (id, body) => {
				calls.push(`meta:${id}:${JSON.stringify(body)}`);
				return { revision: 1 };
			},
			putFontFile: async (id, bytes) => {
				calls.push(`file:${id}:${bytes.length}`);
				return { revision: 2 };
			},
		});
		const pushed = await pushLibraryDirty(c, api);
		expect(pushed).toBe(1);
		expect(calls).toContain("marked:f@2");
		expect(calls).toContain("file:f:4");
	});
});

describe("pull with library", () => {
	it("forgets synced library rows missing from a reset pass", async () => {
		const forgotten: string[] = [];
		const c = cache({
			getCursor: async () => "old",
			listSynced: async () => [],
			forgetTemplate: async () => true,
		});
		const lib = libraryCache({
			listSyncedDatasets: async () => ["d-keep", "d-gone"],
			listSyncedSettings: async () => ["ui_density"],
			forgetDataset: async (id) => void forgotten.push(`dataset:${id}`),
			forgetSetting: async (key) => void forgotten.push(`setting:${key}`),
		});
		const api: EngineApi = {
			fetchChanges: vi
				.fn()
				.mockResolvedValueOnce({ changes: [], next_cursor: "", has_more: false, reset: true })
				.mockResolvedValueOnce({
					changes: [
						{ seq: "9", entity: "dataset", op: "upsert", data: { id: "d-keep" } },
						{ seq: "10", entity: "setting", op: "upsert", data: { key: "ui_density" } },
					],
					next_cursor: "OQ==",
					has_more: false,
					reset: false,
				}),
			fetchTemplate: async () => ({ revision: 1 }),
			putTemplate: async () => ({ revision: 1 }),
			deleteTemplate: async () => {},
			postUse: async () => {},
		};
		const res = await pull(c, api, lib);
		expect(res).toEqual({ pulled: 2, forgotten: 1 });
		expect(forgotten).toEqual(["dataset:d-gone"]);
	});
});

describe("syncOnce with library", () => {
	it("pushes library rows and downloads fonts in the same run", async () => {
		const c = cache({
			getCursor: async () => "",
			applyChanges: async () => ({ applied_upserts: 0, applied_deletes: 0, skipped_dirty: 0 }),
			listTombstoned: async () => [],
			listDirty: async () => [],
			listQueuedUses: async () => [],
		});
		const api: EngineApi = {
			fetchChanges: async () => ({ changes: [], next_cursor: "MQ==", has_more: false, reset: false }),
			fetchTemplate: async () => ({ revision: 1 }),
			putTemplate: async () => ({ revision: 1 }),
			deleteTemplate: async () => {},
			postUse: async () => {},
		};
		const lib = libraryCache({
			listDirtyDatasets: async () => [{ server_id: "d", name: "D", data_json: "{}", base_revision: null }],
			markDatasetPushed: async () => {},
			downloadPendingFonts: async () => ({ downloaded: 2, failed: 1 }),
		});
		const res = await syncOnce(c, api, { cache: lib, api: libraryApi() });
		expect(res).toEqual({
			pulled: 0,
			pushed: 1,
			conflicts: [],
			usesSent: 0,
			forgotten: 0,
			fontsDownloaded: 2,
			fontsFailed: 1,
		});
	});
});

describe("downloadFontFiles", () => {
	it("delegates to the cache", async () => {
		const c = libraryCache({ downloadPendingFonts: async () => ({ downloaded: 3, failed: 0 }) });
		await expect(downloadFontFiles(c)).resolves.toEqual({ downloaded: 3, failed: 0 });
	});
});
