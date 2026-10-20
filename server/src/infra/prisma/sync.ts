import type {
	ChangePage,
	SyncChange,
	SyncDelete,
	SyncQuery,
} from "../../domain/syncPorts.js";
import type { DbClient } from "./client.js";
import { toTemplateView, type PrismaTemplate } from "./views.js";

/**
 * Change tracking reads (REFACTORING.md section 7). One user's writes
 * commit in the order their sequence numbers were handed out (the
 * user_sync row lock), so a reader with a cursor never skips a record:
 * rows carry the number, and the number only moves forward.
 */
export function createSyncRepository(db: DbClient) {
	return {
		async tombstoneFloor(userId: string): Promise<bigint> {
			const min = await db.tombstone.aggregate({
				where: { userId },
				_min: { seq: true },
			});
			return min._min.seq ?? 0n;
		},

		async readSince(
			userId: string,
			query: SyncQuery,
			byteBudget: number,
		): Promise<ChangePage> {
			const wantTemplates = query.types.includes("template");
			const take = query.limit + 1;

			const [templates, tombstones] = await Promise.all([
				wantTemplates
					? db.template.findMany({
							where: { ownerId: userId, changeSeq: { gt: query.cursor } },
							include: {
								owner: { select: { handle: true } },
								_count: { select: { versions: true } },
							},
							orderBy: [{ changeSeq: "asc" }],
							take,
						})
					: [],
				db.tombstone.findMany({
					where: {
						userId,
						seq: { gt: query.cursor },
						...(query.types.length > 0 ? { entity: { in: query.types } } : {}),
					},
					orderBy: [{ seq: "asc" }],
					take,
				}),
			]);

			type Candidate =
				| { seq: bigint; kind: "upsert"; template: PrismaTemplate }
				| { seq: bigint; kind: "delete"; entity: string; entityKey: string };
			const candidates: Candidate[] = [
				...templates.map((t) => ({
					seq: t.changeSeq,
					kind: "upsert" as const,
					template: t,
				})),
				...tombstones.map((t) => ({
					seq: t.seq,
					kind: "delete" as const,
					entity: t.entity,
					entityKey: t.entityKey,
				})),
			].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));

			const hasMoreProbe = candidates.length > query.limit;
			const page = candidates.slice(0, query.limit);

			// Byte budget: stop before exceeding it, but never return an
			// empty page while rows remain (a single row always fits: the
			// largest template is far under the default 8 MiB).
			let used = 0;
			let kept = page.length;
			for (let i = 0; i < page.length; i += 1) {
				const size = estimateSize(page[i]);
				if (used + size > byteBudget && i > 0) {
					kept = i;
					break;
				}
				used += size;
			}
			const trimmed = page.slice(0, kept);
			const hasMore = hasMoreProbe || kept < page.length;

			const changes: SyncChange[] = [];
			for (const candidate of trimmed) {
				if (candidate.kind === "delete") {
					changes.push({
						seq: candidate.seq,
						entity: candidate.entity as SyncDelete["entity"],
						entityKey: candidate.entityKey,
					} satisfies SyncChange);
					continue;
				}
				const head = await db.templateVersion.aggregate({
					where: { templateId: candidate.template.id },
					_max: { versionNo: true },
				});
				changes.push({
					seq: candidate.seq,
					entity: "template",
					data: toTemplateView(candidate.template),
					headVersionNo: head._max.versionNo ?? 0,
				});
			}

			return {
				changes,
				nextCursor:
					trimmed.length > 0 ? trimmed[trimmed.length - 1].seq : query.cursor,
				hasMore,
			};
		},

		async purgeTombstones(olderThan: Date): Promise<number> {
			const result = await db.tombstone.deleteMany({
				where: { deletedAt: { lte: olderThan } },
			});
			return result.count;
		},
	};
}

function estimateSize(
	candidate:
		| { kind: "upsert"; template: PrismaTemplate }
		| { kind: "delete" },
): number {
	if (candidate.kind === "delete") {
		return 100;
	}
	const t = candidate.template;
	return (
		Buffer.byteLength(t.body, "utf8") +
		Buffer.byteLength(t.css, "utf8") +
		Buffer.byteLength(t.readme, "utf8") +
		Buffer.byteLength(t.name, "utf8") +
		Buffer.byteLength(t.summary, "utf8") +
		500
	);
}
