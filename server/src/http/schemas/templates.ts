import { z } from "zod";
import {
	PAGE_MM_MAX,
	PAGE_MM_MIN,
	TEMPLATE_NAME_MAX,
	TEMPLATE_SUMMARY_MAX,
} from "../../domain/templates/index.js";
import { errorBody } from "./error.js";

// Endpoints 5-15 (plan sections 8/9). Size caps are bytes, but Zod's
// .max() counts UTF-16 units, so the schema checks shape and ranges
// while the domain enforces the byte caps authoritatively (a multibyte
// string passes .max() yet exceeds the cap — pinned by tests).

export const putTemplateRequest = z.object({
	name: z.string().trim().min(1).max(TEMPLATE_NAME_MAX),
	summary: z.string().trim().max(TEMPLATE_SUMMARY_MAX).optional(),
	page_w_mm: z.number().gt(PAGE_MM_MIN).max(PAGE_MM_MAX),
	page_h_mm: z.number().gt(PAGE_MM_MIN).max(PAGE_MM_MAX),
	language: z.literal("html").optional(),
	body: z.string(),
	css: z.string().optional(),
	readme: z.string().optional(),
	if_revision: z.number().int().min(1).optional(),
	version: z
		.object({
			created_by: z.enum(["manual", "autosave"]).optional(),
			label: z.string().optional(),
			note: z.string().optional(),
		})
		.optional(),
});

export const templateIdParams = z.object({
	id: z.string().uuid(),
});

export const versionNoParams = z.object({
	n: z.coerce.number().int().min(1),
});

export const restoreBody = z
	.object({
		if_revision: z.number().int().min(1).optional(),
	})
	.optional();

const templateBase = z.object({
	id: z.string().uuid(),
	owner_id: z.string().uuid(),
	owner_handle: z.string(),
	name: z.string(),
	summary: z.string(),
	page_w_mm: z.number(),
	page_h_mm: z.number(),
	language: z.string(),
	use_count: z.number().int(),
	revision: z.number().int(),
	version_count: z.number().int(),
	published_at: z.string().datetime().nullable(),
	updated_at: z.string().datetime(),
});

export const templateSummarySchema = templateBase;

export const templateSchema = templateBase.extend({
	body: z.string(),
	css: z.string(),
	readme: z.string(),
});

export function pageSchema<T extends z.ZodType>(item: T) {
	return z.object({
		items: z.array(item),
		page: z.number().int(),
		page_size: z.number().int(),
		total: z.number().int(),
		has_more: z.boolean(),
	});
}

export const templatePageSchema = pageSchema(templateSummarySchema);

export const versionSummarySchema = z.object({
	version_no: z.number().int(),
	created_by: z.enum(["manual", "autosave", "restore"]),
	label: z.string().nullable(),
	note: z.string().nullable(),
	created_at: z.string().datetime(),
});

export const versionSchema = versionSummarySchema.extend({
	body: z.string(),
	css: z.string(),
});

export const versionPageSchema = pageSchema(versionSummarySchema);

export const pageQuery = z.object({
	page: z.coerce.number().int().min(1).default(1),
	page_size: z.coerce.number().int().min(1).max(100).default(20),
});

export const communityQuery = pageQuery.extend({
	q: z.string().max(100).optional(),
	sort: z.enum(["updated", "used", "name"]).default("updated"),
});

export const useBody = z.object({
	count: z.number().int().min(1).max(100).default(1),
});

export const templateErrorResponses = {
	400: errorBody,
	401: errorBody,
	403: errorBody,
	404: errorBody,
} as const;

export type PutTemplateRequest = z.infer<typeof putTemplateRequest>;
export type TemplateResponse = z.infer<typeof templateSchema>;
export type TemplateSummaryResponse = z.infer<typeof templateSummarySchema>;
export type VersionResponse = z.infer<typeof versionSchema>;
export type VersionSummaryResponse = z.infer<typeof versionSummarySchema>;
