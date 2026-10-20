import type { TemplateView } from "./templatePorts.js";

/** Sync change tracking (REFACTORING.md section 7). Only the signed-in
 * user's own records; Phase 4 adds dataset, profile, setting and font
 * rows. Saved community templates use the manifest, never this stream. */

export type SyncEntity = "template" | "dataset" | "profile" | "setting" | "font";

export interface SyncUpsert {
	seq: bigint;
	entity: "template";
	data: TemplateView;
	headVersionNo: number;
}

export interface SyncDelete {
	seq: bigint;
	entity: SyncEntity;
	entityKey: string;
}

export type SyncChange = SyncUpsert | SyncDelete;

export interface ChangePage {
	changes: SyncChange[];
	nextCursor: bigint;
	hasMore: boolean;
}

export interface SyncQuery {
	cursor: bigint;
	limit: number;
	types: SyncEntity[];
}

export const SYNC_ENTITIES: SyncEntity[] = [
	"template",
	"dataset",
	"profile",
	"setting",
	"font",
];

/** Opaque cursor: base64url of the decimal sequence number. */
export function encodeCursor(seq: bigint): string {
	return Buffer.from(seq.toString(10), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): bigint {	let text: string;
	try {
		text = Buffer.from(raw, "base64url").toString("utf8");
	} catch {
		throw new Error("not a cursor");
	}
	if (!/^[0-9]+$/.test(text)) {
		throw new Error("not a cursor");
	}
	return BigInt(text);
}

export interface SyncRepository {
	/** Oldest cursor still answerable: the smallest kept tombstone
	 * sequence, or 0 when no tombstone was ever written. */
	tombstoneFloor(userId: string): Promise<bigint>;
	/** Merged upserts and deletes after the cursor, in sequence order,
	 * trimmed to the count limit and the byte budget. hasMore tells the
	 * client to call again at once with nextCursor. */
	readSince(
		userId: string,
		query: SyncQuery,
		byteBudget: number,
	): Promise<ChangePage>;
	/** Deletes tombstones at or before the cutoff. Returns the count. */
	purgeTombstones(olderThan: Date): Promise<number>;
}
