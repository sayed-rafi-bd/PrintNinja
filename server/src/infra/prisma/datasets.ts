import {
  NotFoundError,
  RevisionConflictError,
  RevisionRequiredError,
} from "../../domain/errors.js";
import type {
  DatasetRepository,
  DatasetView,
  DatasetWrite,
} from "../../domain/libraryPorts.js";
import type { DbClient } from "./client.js";
import type { Prisma } from "./generated/index.js";

function toView(row: {
  id: string;
  ownerId: string;
  name: string;
  dataJson: string;
  revision: number;
  changeSeq: bigint;
  createdAt: Date;
  updatedAt: Date;
}): DatasetView {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    dataJson: row.dataJson,
    revision: row.revision,
    changeSeq: row.changeSeq,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Next sequence number for the user, row-locked (same contract as
 * templates: writers serialize on user_sync, so revision checks after
 * the bump see committed state). */
async function bumpSeq(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<bigint> {
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

export function createDatasetRepository(db: DbClient): DatasetRepository {
  return {
    async findById(id: string): Promise<DatasetView | null> {
      const row = await db.sampleDataset.findUnique({ where: { id } });
      return row && toView(row);
    },

    async create(input: DatasetWrite): Promise<DatasetView> {
      try {
        const row = await db.$transaction(async (tx) => {
          const seq = await bumpSeq(tx, input.ownerId);
          return tx.sampleDataset.create({
            data: {
              id: input.id,
              ownerId: input.ownerId,
              name: input.name,
              dataJson: input.dataJson,
              changeSeq: seq,
            },
          });
        });
        return toView(row);
      } catch (error: unknown) {
        if (isUniqueViolation(error)) {
          // A retried create racing the first: the row now
          // exists, so the caller retries as an update.
          throw new RevisionRequiredError();
        }
        throw error;
      }
    },

    async update(
      input: DatasetWrite,
      expectedRevision: number,
    ): Promise<DatasetView> {
      const row = await db.$transaction(async (tx) => {
        // Bump first: the user_sync row lock serializes this user's
        // writers, so the revision read below is never stale.
        const seq = await bumpSeq(tx, input.ownerId);
        const current = await tx.sampleDataset.findUnique({
          where: { id: input.id },
        });
        if (!current) {
          throw new NotFoundError();
        }
        if (current.revision !== expectedRevision) {
          throw new RevisionConflictError(current.revision);
        }
        return tx.sampleDataset.update({
          where: { id: input.id },
          data: {
            name: input.name,
            dataJson: input.dataJson,
            revision: current.revision + 1,
            changeSeq: seq,
          },
        });
      });
      return toView(row);
    },

    async deleteWithTombstone(id: string): Promise<{ ownerId: string } | null> {
      return db.$transaction(async (tx) => {
        const current = await tx.sampleDataset.findUnique({ where: { id } });
        if (!current) {
          return null;
        }
        const seq = await bumpSeq(tx, current.ownerId);
        await tx.tombstone.create({
          data: {
            userId: current.ownerId,
            seq,
            entity: "dataset",
            entityKey: id,
          },
        });
        await tx.sampleDataset.delete({ where: { id } });
        return { ownerId: current.ownerId };
      });
    },

    async listByOwner(ownerId: string): Promise<DatasetView[]> {
      const rows = await db.sampleDataset.findMany({
        where: { ownerId },
        orderBy: [{ name: "asc" }],
      });
      return rows.map(toView);
    },
  };
}
