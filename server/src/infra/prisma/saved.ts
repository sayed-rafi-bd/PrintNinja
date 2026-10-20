import type {
	PageQuery,
	SavedRepository,
	TemplateSummaryView,
} from "../../domain/templatePorts.js";
import { toPage } from "../../domain/pagination.js";
import type { DbClient } from "./client.js";

type PrismaSavedRow = {
	template: {
		id: string;
		ownerId: string;
		owner: { handle: string };
		name: string;
		summary: string;
		pageWMm: number;
		pageHMm: number;
		language: string;
		useCount: number;
		revision: number;
		publishedAt: Date | null;
		updatedAt: Date;
		_count: { versions: number };
	};
};

export function createSavedRepository(db: DbClient): SavedRepository {
	return {
		async list(userId: string, query: PageQuery) {
			// Unpublished templates are filtered out but their rows
			// survive, so republishing restores the list as it was.
			const where = { userId, template: { publishedAt: { not: null } } };
			const [total, rows] = await Promise.all([
				db.savedTemplate.count({ where }),
				db.savedTemplate.findMany({
					where,
					include: {
						template: {
							include: { owner: { select: { handle: true } }, _count: { select: { versions: true } } },
						},
					},
					orderBy: [{ addedAt: "desc" }, { templateId: "asc" }],
					skip: (query.page - 1) * query.pageSize,
					take: query.pageSize,
				}),
			]);
			return toPage(rows.map((row) => toSummary(row.template)), total, query);
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
	};
}

function toSummary(template: PrismaSavedRow["template"]): TemplateSummaryView {
	return {
		id: template.id,
		ownerId: template.ownerId,
		ownerHandle: template.owner.handle,
		name: template.name,
		summary: template.summary,
		pageWMm: template.pageWMm,
		pageHMm: template.pageHMm,
		language: template.language,
		useCount: template.useCount,
		revision: template.revision,
		versionCount: template._count.versions,
		publishedAt: template.publishedAt,
		updatedAt: template.updatedAt,
	};
}
