import { NotFoundError, RevisionConflictError, RevisionRequiredError } from "../../domain/errors.js";
import type {
	SettingRepository,
	SettingView,
	SettingWrite,
} from "../../domain/libraryPorts.js";
import type { DbClient } from "./client.js";
import type { Prisma } from "./generated/index.js";

function toView(row: {
	userId: string;
	key: string;
	value: string;
	revision: number;
	changeSeq: bigint;
	updatedAt: Date;
}): SettingView {
	return {
		ownerId: row.userId,
		key: row.key,
		value: row.value,
		revision: row.revision,
		changeSeq: row.changeSeq,
		updatedAt: row.updatedAt,
	};
}

async function bumpSeq(tx: Prisma.TransactionClient, userId: string): Promise<bigint> {
	const row = await tx.userSync.upsert({
		where: { userId },
		update: { nextSeq: { increment: 1n } },
		create: { userId, nextSeq: 2n },
	});
	return row.nextSeq;
}

function isUniqueViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "P2002"
	);
}

export function createSettingRepository(db: DbClient): SettingRepository {
	return {
		async findByKey(ownerId, key) {
			const row = await db.userSetting.findUnique({ where: { userId_key: { userId: ownerId, key } } });
			return row && toView(row);
		},

		async create(input: SettingWrite): Promise<SettingView> {
			try {
				const row = await db.$transaction(async (tx) => {
					const seq = await bumpSeq(tx, input.ownerId);
					return tx.userSetting.create({
						data: { userId: input.ownerId, key: input.key, value: input.value, changeSeq: seq },
					});
				});
				return toView(row);
			} catch (error: unknown) {
				if (isUniqueViolation(error)) {
					throw new RevisionRequiredError();
				}
				throw error;
			}
		},

		async update(input: SettingWrite, expectedRevision: number): Promise<SettingView> {
			const row = await db.$transaction(async (tx) => {
				const seq = await bumpSeq(tx, input.ownerId);
				const current = await tx.userSetting.findUnique({
					where: { userId_key: { userId: input.ownerId, key: input.key } },
				});
				if (!current) {
					throw new NotFoundError();
				}
				if (current.revision !== expectedRevision) {
					throw new RevisionConflictError(current.revision);
				}
				return tx.userSetting.update({
					where: { userId_key: { userId: input.ownerId, key: input.key } },
					data: { value: input.value, revision: current.revision + 1, changeSeq: seq },
				});
			});
			return toView(row);
		},

		async deleteWithTombstone(ownerId, key): Promise<boolean> {
			return db.$transaction(async (tx) => {
				const current = await tx.userSetting.findUnique({ where: { userId_key: { userId: ownerId, key } } });
				if (!current) {
					return false;
				}
				const seq = await bumpSeq(tx, ownerId);
				await tx.tombstone.create({ data: { userId: ownerId, seq, entity: "setting", entityKey: key } });
				await tx.userSetting.delete({ where: { userId_key: { userId: ownerId, key } } });
				return true;
			});
		},

		async listByOwner(ownerId): Promise<SettingView[]> {
			const rows = await db.userSetting.findMany({ where: { userId: ownerId }, orderBy: [{ key: "asc" }] });
			return rows.map(toView);
		},
	};
}
