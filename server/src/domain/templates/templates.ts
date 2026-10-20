import { ForbiddenError, NotFoundError } from "../errors.js";
import type { Page } from "../pagination.js";
import type {
	PageQuery,
	PublishedQuery,
	TemplateRepository,
	TemplateSummaryView,
	TemplateView,
} from "../templatePorts.js";

/**
 * Reads one template. Missing, or private and owned by someone else,
 * are the same 404 on purpose, so ids cannot be probed. The invalid
 * token case never reaches here — the HTTP layer answers 401 first.
 */
export async function getTemplate(
	repos: { templates: TemplateRepository },
	id: string,
	viewerUserId: string | null,
): Promise<TemplateView> {
	const template = await repos.templates.findById(id);
	if (
		!template ||
		(template.publishedAt === null && template.ownerId !== viewerUserId)
	) {
		throw new NotFoundError();
	}
	return template;
}

/**
 * Deletes permanently. Versions and saved rows cascade in the database;
 * the tombstone (own plus, later, datasets and profiles) is written in
 * the same transaction so delta sync never misses the delete.
 */
export async function deleteTemplate(
	repos: { templates: TemplateRepository },
	id: string,
	ownerId: string,
): Promise<void> {
	const template = await repos.templates.findById(id);
	if (!template) {
		throw new NotFoundError();
	}
	if (template.ownerId !== ownerId) {
		throw new ForbiddenError();
	}
	await repos.templates.deleteWithTombstone(id);
}

/**
 * Makes a template public, keeping the first publish time on repeats.
 * Like every accepted mutation it takes a fresh sequence number, but
 * the content is untouched so the revision stands still.
 */
export async function publishTemplate(
	repos: { templates: TemplateRepository },
	id: string,
	ownerId: string,
	now: Date,
): Promise<TemplateView> {
	const template = await repos.templates.findById(id);
	if (!template) {
		throw new NotFoundError();
	}
	if (template.ownerId !== ownerId) {
		throw new ForbiddenError();
	}
	const published = await repos.templates.setPublished(
		id,
		template.publishedAt ?? now,
	);
	if (!published) {
		throw new NotFoundError();
	}
	return published;
}

/**
 * Makes a template private. The saved rows survive (unlike a delete),
 * so republishing restores the saved list as it was.
 */
export async function unpublishTemplate(
	repos: { templates: TemplateRepository },
	id: string,
	ownerId: string,
): Promise<void> {
	const template = await repos.templates.findById(id);
	if (!template) {
		throw new NotFoundError();
	}
	if (template.ownerId !== ownerId) {
		throw new ForbiddenError();
	}
	await repos.templates.setPublished(id, null);
}

/** The owner's own templates, private and published, newest first. */
export async function listMine(
	repos: { templates: TemplateRepository },
	ownerId: string,
	query: PageQuery,
): Promise<Page<TemplateSummaryView>> {
	return repos.templates.listByOwner(ownerId, query);
}

/** Published templates for everyone: search, sort, pages. */
export async function listCommunity(
	repos: { templates: TemplateRepository },
	query: PublishedQuery,
): Promise<Page<TemplateSummaryView>> {
	return repos.templates.listPublished(query);
}

/**
 * Counts prints of a published template. Missing or private is the same
 * 404, so the counter cannot probe for private ids either.
 */
export async function recordUse(
	repos: { templates: TemplateRepository },
	id: string,
	count: number,
): Promise<void> {
	const counted = await repos.templates.incrementUseCount(id, count);
	if (!counted) {
		throw new NotFoundError();
	}
}
