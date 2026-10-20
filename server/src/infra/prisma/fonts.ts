import { NotFoundError, RevisionConflictError, RevisionRequiredError } from "../../domain/errors.js";
import type {
	FontRepository,
	FontView,
	UploadedFont,
} from "../../domain/libraryPorts.js";
import type { DbClient } from "./client.js";
import type { Prisma } from "./generated/index.js";

function toView(row: {
	id: string;
	ownerId: string;
	name: string;
	format: string;
	sizeBytes: number;
	sha256: string;
	revision: number;
	changeSeq: bigint;
	createdAt: Date;
	updatedAt: Date;
}): FontView {
	return {
		id: row.id,
		ownerId: row.ownerId,
		name: row.name,
		format: row.format,
		sizeBytes: row.sizeBytes,
		sha256: row.sha256,
		revision: row.revision,
		changeSeq: row.changeSeq,
		createdAt: row.createdAt,
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

export function createFontRepository(db: DbClient): FontRepository {
	return {
		async findById(id) {
			const row = await db.font.findUnique({ where: { id } });
			return row && toView(row);
		},

		async findFile(id) {
			const row = await db.font.findUnique({ where: { id }, include: { file: true } });
			if (!row || !row.file) {
				return null;
			}
			return { ...toView(row), bytes: new Uint8Array(row.file.bytes) };
		},

		async countByOwner(ownerId) {
			return db.font.count({ where: { ownerId } });
		},

		async create(input) {
			try {
				const row = await db.$transaction(async (tx) => {
					const seq = await bumpSeq(tx, input.ownerId);
					return tx.font.create({
						data: { id: input.id, ownerId: input.ownerId, name: input.name, changeSeq: seq },
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

		async updateName(input, expectedRevision) {
			const row = await db.$transaction(async (tx) => {
				const seq = await bumpSeq(tx, input.ownerId);
				const current = await tx.font.findUnique({ where: { id: input.id } });
				if (!current) {
					throw new NotFoundError();
				}
				if (current.revision !== expectedRevision) {
					throw new RevisionConflictError(current.revision);
				}
				return tx.font.update({
					where: { id: input.id },
					data: { name: input.name, revision: current.revision + 1, changeSeq: seq },
				});
			});
			return toView(row);
		},

		async replaceFile(input): Promise<UploadedFont> {
			const row = await db.$transaction(async (tx) => {
				const seq = await bumpSeq(tx, input.ownerId);
				const current = await tx.font.findUnique({ where: { id: input.id } });
				if (!current) {
					throw new NotFoundError();
				}
				const updated = await tx.font.update({
					where: { id: input.id },
					data: {
						format: input.format,
						sizeBytes: input.bytes.length,
						sha256: input.sha256,
						revision: current.revision + 1,
						changeSeq: seq,
					},
				});
				await tx.fontFile.upsert({
					where: { fontId: input.id },
					update: { bytes: Buffer.from(input.bytes) },
					create: { fontId: input.id, bytes: Buffer.from(input.bytes) },
				});
				return updated;
			});
			return { ...toView(row), bytes: input.bytes };
		},

		async deleteWithTombstone(id) {
			return db.$transaction(async (tx) => {
				const current = await tx.font.findUnique({ where: { id } });
				if (!current) {
					return null;
				}
				const seq = await bumpSeq(tx, current.ownerId);
				await tx.tombstone.create({ data: { userId: current.ownerId, seq, entity: "font", entityKey: id } });
				await tx.font.delete({ where: { id } });
				return { ownerId: current.ownerId };
			});
		},

		async listByOwner(ownerId) {
			const rows = await db.font.findMany({ where: { ownerId }, orderBy: [{ name: "asc" }] });
			return rows.map(toView);
		},
	};
}
