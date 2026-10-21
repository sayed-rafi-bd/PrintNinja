import { ValidationError } from "../errors.js";
import type { ChangePage, SyncEntity, SyncChange } from "../syncPorts.js";
import { decodeCursor, SYNC_ENTITIES } from "../syncPorts.js";
import type { SyncRepository } from "../syncPorts.js";

export interface ReadChangesInput {
  cursor: bigint | null;
  limit: number;
  types: SyncEntity[];
}

export interface ReadChangesResult {
  changes: SyncChange[];
  nextCursor: bigint;
  hasMore: boolean;
  reset: boolean;
}

/**
 * Reads the delta stream. A cursor below the tombstone floor answers
 * reset: true with a full pass from the start, so the client drops every
 * cache row the pass does not contain. Cursor parsing and entity-name
 * validation live here (no database needed to reject them); encoding the
 * opaque cursor back is the HTTP layer's job.
 */
export async function readChanges(
  repos: { sync: SyncRepository },
  userId: string,
  input: ReadChangesInput,
  byteBudget: number,
): Promise<ReadChangesResult> {
  const floor = await repos.sync.tombstoneFloor(userId);
  const reset = input.cursor !== null && input.cursor < floor;
  const page: ChangePage = await repos.sync.readSince(
    userId,
    {
      cursor: reset ? 0n : (input.cursor ?? 0n),
      limit: input.limit,
      types: input.types,
    },
    byteBudget,
  );
  return {
    changes: page.changes,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    reset,
  };
}

export function parseCursor(raw: string | undefined): bigint | null {
  if (raw === undefined || raw === "") {
    return null;
  }
  try {
    return decodeCursor(raw);
  } catch {
    throw new ValidationError("Invalid since cursor", [
      { path: "since", message: "Must be an opaque cursor from next_cursor" },
    ]);
  }
}

export function parseTypes(raw: string | undefined): SyncEntity[] {
  if (raw === undefined || raw.trim() === "") {
    return [...SYNC_ENTITIES];
  }
  const wanted = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  const unknown = wanted.filter(
    (t) => !(SYNC_ENTITIES as string[]).includes(t),
  );
  if (unknown.length > 0) {
    throw new ValidationError("Unknown sync entity", [
      { path: "types", message: `Unknown entity: ${unknown.join(", ")}` },
    ]);
  }
  return [...new Set(wanted)] as SyncEntity[];
}

/**
 * Purges tombstones older than the retention window. The floor — the
 * smallest kept sequence — is what makes stale cursors answer reset.
 */
export async function purgeOldTombstones(
  repos: { sync: SyncRepository },
  now: Date,
  retentionDays: number,
): Promise<number> {
  return repos.sync.purgeTombstones(
    new Date(now.getTime() - retentionDays * 86_400_000),
  );
}
