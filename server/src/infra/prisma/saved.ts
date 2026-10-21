import type {
  ManifestSource,
  PageQuery,
  SavedRepository,
} from "../../domain/templatePorts.js";
import { toPage } from "../../domain/pagination.js";
import type { DbClient } from "./client.js";
import { toTemplateSummaryView, toTemplateView } from "./views.js";

/**
 * Saved rows survive template deletes (no FK to templates — E14 needs
 * the manifest to report them as deleted), so joins are manual and
 * bounded by the 1,000-row per-user quota.
 */
export function createSavedRepository(db: DbClient): SavedRepository {
  return {
    async list(userId: string, query: PageQuery) {
      const saved = await db.savedTemplate.findMany({
        where: { userId },
        orderBy: [{ addedAt: "desc" }, { templateId: "asc" }],
      });
      const templates = await db.template.findMany({
        where: {
          id: { in: saved.map((row) => row.templateId) },
          publishedAt: { not: null },
        },
        include: {
          owner: { select: { handle: true } },
          _count: { select: { versions: true } },
        },
      });
      const byId = new Map(templates.map((t) => [t.id, t]));
      // Unpublished templates are filtered out but their rows
      // survive, so republishing restores the list as it was.
      const items = saved.flatMap((row) => {
        const template = byId.get(row.templateId);
        return template ? [toTemplateSummaryView(template)] : [];
      });
      return toPage(
        items.slice(
          (query.page - 1) * query.pageSize,
          query.page * query.pageSize,
        ),
        items.length,
        query,
      );
    },

    async countByUser(userId: string): Promise<number> {
      return db.savedTemplate.count({ where: { userId } });
    },

    async save(userId: string, templateId: string): Promise<void> {
      await db.savedTemplate.upsert({
        where: { userId_templateId: { userId, templateId } },
        update: {},
        create: { userId, templateId },
      });
    },

    async unsave(userId: string, templateId: string): Promise<void> {
      await db.savedTemplate.deleteMany({ where: { userId, templateId } });
    },

    async listManifest(userId: string): Promise<ManifestSource[]> {
      const saved = await db.savedTemplate.findMany({
        where: { userId },
        orderBy: [{ addedAt: "desc" }, { templateId: "asc" }],
      });
      const templates = await db.template.findMany({
        where: { id: { in: saved.map((row) => row.templateId) } },
        include: {
          owner: { select: { handle: true } },
          _count: { select: { versions: true } },
        },
      });
      const byId = new Map(templates.map((t) => [t.id, t]));
      const out: ManifestSource[] = [];
      for (const row of saved) {
        const template = byId.get(row.templateId) ?? null;
        if (template) {
          out.push({
            templateId: row.templateId,
            addedAt: row.addedAt,
            template: toTemplateView(template),
            deletedAt: null,
          });
          continue;
        }
        const tomb = await db.tombstone.findFirst({
          where: { userId, entity: "template", entityKey: row.templateId },
        });
        out.push({
          templateId: row.templateId,
          addedAt: row.addedAt,
          template: null,
          deletedAt: tomb?.deletedAt ?? null,
        });
      }
      return out;
    },
  };
}
