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
      const wantDatasets = query.types.includes("dataset");
      const wantProfiles = query.types.includes("profile");
      const wantSettings = query.types.includes("setting");
      const wantFonts = query.types.includes("font");
      const take = query.limit + 1;

      const [templates, datasets, profiles, settings, fonts, tombstones] =
        await Promise.all([
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
          wantDatasets
            ? db.sampleDataset.findMany({
                where: { ownerId: userId, changeSeq: { gt: query.cursor } },
                orderBy: [{ changeSeq: "asc" }],
                take,
              })
            : [],
          wantProfiles
            ? db.printerProfile.findMany({
                where: { ownerId: userId, changeSeq: { gt: query.cursor } },
                orderBy: [{ changeSeq: "asc" }],
                take,
              })
            : [],
          wantSettings
            ? db.userSetting.findMany({
                where: { userId, changeSeq: { gt: query.cursor } },
                orderBy: [{ changeSeq: "asc" }],
                take,
              })
            : [],
          wantFonts
            ? db.font.findMany({
                where: { ownerId: userId, changeSeq: { gt: query.cursor } },
                orderBy: [{ changeSeq: "asc" }],
                take,
              })
            : [],
          db.tombstone.findMany({
            where: {
              userId,
              seq: { gt: query.cursor },
              ...(query.types.length > 0
                ? { entity: { in: query.types } }
                : {}),
            },
            orderBy: [{ seq: "asc" }],
            take,
          }),
        ]);

      type Candidate =
        | {
            seq: bigint;
            kind: "upsert";
            entity: "template";
            template: PrismaTemplate;
          }
        | {
            seq: bigint;
            kind: "upsert";
            entity: "dataset";
            dataset: (typeof datasets)[number];
          }
        | {
            seq: bigint;
            kind: "upsert";
            entity: "profile";
            profile: (typeof profiles)[number];
          }
        | {
            seq: bigint;
            kind: "upsert";
            entity: "setting";
            setting: (typeof settings)[number];
          }
        | {
            seq: bigint;
            kind: "upsert";
            entity: "font";
            font: (typeof fonts)[number];
          }
        | { seq: bigint; kind: "delete"; entity: string; entityKey: string };
      const candidates: Candidate[] = [
        ...templates.map((t) => ({
          seq: t.changeSeq,
          kind: "upsert" as const,
          entity: "template" as const,
          template: t,
        })),
        ...datasets.map((d) => ({
          seq: d.changeSeq,
          kind: "upsert" as const,
          entity: "dataset" as const,
          dataset: d,
        })),
        ...profiles.map((p) => ({
          seq: p.changeSeq,
          kind: "upsert" as const,
          entity: "profile" as const,
          profile: p,
        })),
        ...settings.map((s) => ({
          seq: s.changeSeq,
          kind: "upsert" as const,
          entity: "setting" as const,
          setting: s,
        })),
        ...fonts.map((f) => ({
          seq: f.changeSeq,
          kind: "upsert" as const,
          entity: "font" as const,
          font: f,
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
        if (candidate.entity === "dataset") {
          const d = candidate.dataset;
          changes.push({
            seq: candidate.seq,
            entity: "dataset",
            data: {
              id: d.id,
              ownerId: d.ownerId,
              name: d.name,
              dataJson: d.dataJson,
              revision: d.revision,
              changeSeq: d.changeSeq,
              createdAt: d.createdAt,
              updatedAt: d.updatedAt,
            },
          });
          continue;
        }
        if (candidate.entity === "profile") {
          const p = candidate.profile;
          changes.push({
            seq: candidate.seq,
            entity: "profile",
            data: {
              id: p.id,
              ownerId: p.ownerId,
              templateId: p.templateId,
              printerName: p.printerName,
              settingsJson: p.settingsJson,
              revision: p.revision,
              changeSeq: p.changeSeq,
              createdAt: p.createdAt,
              updatedAt: p.updatedAt,
            },
          });
          continue;
        }
        if (candidate.entity === "setting") {
          const s = candidate.setting;
          changes.push({
            seq: candidate.seq,
            entity: "setting",
            data: {
              ownerId: s.userId,
              key: s.key,
              value: s.value,
              revision: s.revision,
              changeSeq: s.changeSeq,
              updatedAt: s.updatedAt,
            },
          });
          continue;
        }
        if (candidate.entity === "font") {
          const f = candidate.font;
          changes.push({
            seq: candidate.seq,
            entity: "font",
            data: {
              id: f.id,
              ownerId: f.ownerId,
              name: f.name,
              format: f.format,
              sizeBytes: f.sizeBytes,
              sha256: f.sha256,
              revision: f.revision,
              changeSeq: f.changeSeq,
              createdAt: f.createdAt,
              updatedAt: f.updatedAt,
            },
          });
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

function estimateSize(candidate: {
  kind: string;
  template?: PrismaTemplate;
  dataset?: { name: string; dataJson: string };
  profile?: { printerName: string; settingsJson: string };
  setting?: { key: string; value: string };
  font?: { name: string };
}): number {
  if (candidate.kind === "delete") {
    return 100;
  }
  if (candidate.dataset) {
    return (
      Buffer.byteLength(candidate.dataset.dataJson, "utf8") +
      Buffer.byteLength(candidate.dataset.name, "utf8") +
      300
    );
  }
  if (candidate.profile) {
    return (
      Buffer.byteLength(candidate.profile.settingsJson, "utf8") +
      Buffer.byteLength(candidate.profile.printerName, "utf8") +
      300
    );
  }
  if (candidate.setting) {
    return (
      Buffer.byteLength(candidate.setting.value, "utf8") +
      Buffer.byteLength(candidate.setting.key, "utf8") +
      200
    );
  }
  if (candidate.font) {
    return Buffer.byteLength(candidate.font.name, "utf8") + 300;
  }
  const t = candidate.template as PrismaTemplate;
  return (
    Buffer.byteLength(t.body, "utf8") +
    Buffer.byteLength(t.css, "utf8") +
    Buffer.byteLength(t.readme, "utf8") +
    Buffer.byteLength(t.name, "utf8") +
    Buffer.byteLength(t.summary, "utf8") +
    500
  );
}
