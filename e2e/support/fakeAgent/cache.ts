// In-memory sync cache for the fake desktop agent
// (REFACTORING.md section 11, Phase 3). Mirrors the Rust cache commands
// field for field: apply is atomic (validate first, then mutate), dirty
// rows survive pulls and remote deletes, unknown entities and ops fail
// the whole page, versions append as created_by=sync and prune beyond
// the newest 20, and the cursor only moves on success. The shared
// cache_cases.json runs the same behaviors against both.

export type SyncStateName = "synced" | "dirty" | "deleted_pending" | "conflict";

export interface FakeVersion {
	version_no: number;
	html: string;
	css: string;
	created_by: string;
}

export interface FakeTemplateRow {
	id: number;
	server_id: string | null;
	name: string;
	summary: string;
	page_w: number;
	page_h: number;
	orientation: "portrait" | "landscape";
	readme: string;
	published_at: string | null;
	updated_at: string;
	server_revision: number | null;
	base_revision: number | null;
	sync_state: SyncStateName;
	kind: "own" | "saved";
	owner_handle: string | null;
	synced_at: string | null;
	versions: FakeVersion[];
}

export interface FakeSyncState {
	account_handle: string | null;
	server_url: string | null;
	cursor: string;
	last_pull_at: string | null;
	last_error: string | null;
}

export interface SyncChangeIn {
	seq: number;
	entity: string;
	op: string;
	data?: Record<string, unknown>;
	id?: string;
}

export interface ApplyReport {
	applied_upserts: number;
	applied_deletes: number;
	skipped_dirty: number;
}

export function createFakeCache() {
	let nextId = 1;
	const templates = new Map<number, FakeTemplateRow>();
	const sync: FakeSyncState = {
		account_handle: null,
		server_url: null,
		cursor: "",
		last_pull_at: null,
		last_error: null,
	};

	const findByServerId = (serverId: string): FakeTemplateRow | undefined => {
		for (const row of templates.values()) {
			if (row.server_id === serverId) {
				return row;
			}
		}
		return undefined;
	};

	const nowIso = () => new Date().toISOString();

	function validate(changes: SyncChangeIn[]): void {
		for (const change of changes) {
			if (change.op !== "upsert" && change.op !== "delete") {
				throw new Error(`unsupported sync op '${change.op}'`);
			}
			if (change.entity !== "template") {
				throw new Error(`unsupported sync entity '${change.entity}'`);
			}
			if (change.op === "upsert" && (change.data === undefined || change.data === null)) {
				throw new Error("sync upsert without data");
			}
			if (change.op === "delete" && typeof change.id !== "string") {
				throw new Error("sync delete without id");
			}
		}
	}

	function pruneVersions(row: FakeTemplateRow): void {
		if (row.versions.length > 20) {
			row.versions = row.versions.slice(-20);
		}
	}

	function applyUpsert(data: Record<string, unknown>, report: ApplyReport): void {
		const serverId = data["id"] as string;
		const existing = findByServerId(serverId);
		if (existing && existing.sync_state === "dirty") {
			report.skipped_dirty += 1;
			return;
		}
		const pageW = Math.round(Number(data["page_w_mm"] ?? 0));
		const pageH = Math.round(Number(data["page_h_mm"] ?? 0));
		const orientation = pageW > pageH ? "landscape" : "portrait";
		const html = String(data["body"] ?? "");
		const css = String(data["css"] ?? "");
		if (!existing) {
			const row: FakeTemplateRow = {
				id: nextId++,
				server_id: serverId,
				name: String(data["name"] ?? ""),
				summary: String(data["summary"] ?? ""),
				page_w: pageW,
				page_h: pageH,
				orientation,
				readme: String(data["readme"] ?? ""),
				published_at: (data["published_at"] as string | null) ?? null,
				updated_at: String(data["updated_at"] ?? nowIso()),
				server_revision: Number(data["revision"] ?? 1),
				base_revision: Number(data["revision"] ?? 1),
				sync_state: "synced",
				kind: "own",
				owner_handle: null,
				synced_at: nowIso(),
				versions: [{ version_no: 1, html, css, created_by: "sync" }],
			};
			templates.set(row.id, row);
			report.applied_upserts += 1;
			return;
		}
		existing.name = String(data["name"] ?? existing.name);
		existing.summary = typeof data["summary"] === "string" ? data["summary"] : existing.summary;
		existing.page_w = pageW;
		existing.page_h = pageH;
		existing.orientation = orientation;
		existing.readme = typeof data["readme"] === "string" ? data["readme"] : existing.readme;
		existing.published_at = (data["published_at"] as string | null) ?? null;
		existing.updated_at = String(data["updated_at"] ?? nowIso());
		existing.server_revision = Number(data["revision"] ?? existing.server_revision);
		existing.base_revision = existing.server_revision;
		existing.sync_state = "synced";
		existing.synced_at = nowIso();
		const maxNo = existing.versions.reduce((m, v) => Math.max(m, v.version_no), 0);
		existing.versions.push({ version_no: maxNo + 1, html, css, created_by: "sync" });
		pruneVersions(existing);
		report.applied_upserts += 1;
	}

	function applyDelete(serverId: string, report: ApplyReport): void {
		const existing = findByServerId(serverId);
		if (!existing) {
			return;
		}
		if (existing.sync_state === "dirty") {
			report.skipped_dirty += 1;
			return;
		}
		templates.delete(existing.id);
		report.applied_deletes += 1;
	}

	return {
		/** Test seam: the raw store plus an id allocator. */
		_store: { templates, sync, nextId: () => nextId++ },

		applyChanges(changes: SyncChangeIn[], newCursor: string): ApplyReport {
			validate(changes);
			const report: ApplyReport = { applied_upserts: 0, applied_deletes: 0, skipped_dirty: 0 };
			for (const change of changes) {
				if (change.op === "upsert") {
					applyUpsert(change.data as Record<string, unknown>, report);
				} else {
					applyDelete(change.id as string, report);
				}
			}
			sync.cursor = newCursor;
			sync.last_pull_at = nowIso();
			sync.last_error = null;
			return report;
		},

		getSyncState(): FakeSyncState {
			return { ...sync };
		},

		listDirty(): FakeTemplateRow[] {
			return [...templates.values()].filter((t) => t.sync_state === "dirty");
		},

		markPushed(serverId: string, revision: number): void {
			const row = findByServerId(serverId);
			if (!row) {
				throw new Error(`no cached template with server id ${serverId}`);
			}
			row.sync_state = "synced";
			row.server_revision = revision;
			row.base_revision = revision;
		},
	};
}

export type FakeCache = ReturnType<typeof createFakeCache>;
