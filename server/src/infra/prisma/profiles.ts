import {
  NotFoundError,
  RevisionConflictError,
  RevisionRequiredError,
} from "../../domain/errors.js";
import type {
  ProfileRepository,
  ProfileView,
  ProfileWrite,
} from "../../domain/libraryPorts.js";
import type { DbClient } from "./client.js";
import type { Prisma } from "./generated/index.js";

function toView(row: {
  id: string;
  ownerId: string;
  templateId: string;
  printerName: string;
  settingsJson: string;
  revision: number;
  changeSeq: bigint;
  createdAt: Date;
  updatedAt: Date;
}): ProfileView {
  return {
    id: row.id,
    ownerId: row.ownerId,
    templateId: row.templateId,
    printerName: row.printerName,
    settingsJson: row.settingsJson,
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

export function createProfileRepository(db: DbClient): ProfileRepository {
  return {
    async findById(id: string): Promise<ProfileView | null> {
      const row = await db.printerProfile.findUnique({ where: { id } });
      return row && toView(row);
    },

    async create(input: ProfileWrite): Promise<ProfileView> {
      try {
        const row = await db.$transaction(async (tx) => {
          const seq = await bumpSeq(tx, input.ownerId);
          return tx.printerProfile.create({
            data: {
              id: input.id,
              ownerId: input.ownerId,
              templateId: input.templateId,
              printerName: input.printerName,
              settingsJson: input.settingsJson,
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
      input: ProfileWrite,
      expectedRevision: number,
    ): Promise<ProfileView> {
      const row = await db.$transaction(async (tx) => {
        // Bump first: the user_sync row lock serializes this user's
        // writers, so the revision read below is never stale.
        const seq = await bumpSeq(tx, input.ownerId);
        const current = await tx.printerProfile.findUnique({
          where: { id: input.id },
        });
        if (!current) {
          throw new NotFoundError();
        }
        if (current.revision !== expectedRevision) {
          throw new RevisionConflictError(current.revision);
        }
        return tx.printerProfile.update({
          where: { id: input.id },
          data: {
            templateId: input.templateId,
            printerName: input.printerName,
            settingsJson: input.settingsJson,
            revision: current.revision + 1,
            changeSeq: seq,
          },
        });
      });
      return toView(row);
    },

    async deleteWithTombstone(id: string): Promise<{ ownerId: string } | null> {
      return db.$transaction(async (tx) => {
        const current = await tx.printerProfile.findUnique({ where: { id } });
        if (!current) {
          return null;
        }
        const seq = await bumpSeq(tx, current.ownerId);
        await tx.tombstone.create({
          data: {
            userId: current.ownerId,
            seq,
            entity: "profile",
            entityKey: id,
          },
        });
        await tx.printerProfile.delete({ where: { id } });
        return { ownerId: current.ownerId };
      });
    },

    async listByOwner(ownerId: string): Promise<ProfileView[]> {
      const rows = await db.printerProfile.findMany({
        where: { ownerId },
        orderBy: [{ updatedAt: "desc" }],
      });
      return rows.map(toView);
    },
  };
}
