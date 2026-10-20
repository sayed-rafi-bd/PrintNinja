import { NotFoundError, QuotaExceededError } from "../errors.js";
import type { Page } from "../pagination.js";
import type {
	PageQuery,
	SavedRepository,
	TemplateRepository,
	TemplateSummaryView,
} from "../templatePorts.js";

/** Per-user cap on saved templates (plan section 9). */
export const MAX_SAVED_PER_USER = 1000;

/** Saved community templates, most recently saved first. Templates
 * their author has unpublished are left out (the rows survive, so
 * republishing restores the list). */
export async function listSaved(
	repos: { saved: SavedRepository },
	userId: string,
	query: PageQuery,
): Promise<Page<TemplateSummaryView>> {
	return repos.saved.list(userId, query);
}

/**
 * Saves a published template. Missing or private is a 404; over quota
 * is a 409; repeating a save is a 204, not an error.
 */
export async function saveTemplate(
	repos: { templates: TemplateRepository; saved: SavedRepository },
	userId: string,
	id: string,
): Promise<void> {
	const template = await repos.templates.findById(id);
	if (!template || template.publishedAt === null) {
		throw new NotFoundError();
	}
	const saved = await repos.saved.countByUser(userId);
	if (saved >= MAX_SAVED_PER_USER) {
		throw new QuotaExceededError(
			`Saved template limit reached (${MAX_SAVED_PER_USER})`,
		);
	}
	await repos.saved.save(userId, id);
}

/** Removes from the saved list. Never fails: nothing saved, or even an
 * unknown template, is still a success. */
export async function unsaveTemplate(
	repos: { saved: SavedRepository },
	userId: string,
	id: string,
): Promise<void> {
	await repos.saved.unsave(userId, id);
}
