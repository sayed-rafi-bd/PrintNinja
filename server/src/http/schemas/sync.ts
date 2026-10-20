import { z } from "zod";
import { templateSchema } from "./templates.js";

// Endpoints 21 (delta sync) and 22 (saved manifest), plan sections 7/9.
// Cursors stay opaque base64; the domain parses and validates them.

export const syncQuery = z.object({
	since: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(500).default(100),
	types: z.string().optional(),
});

const templateChangeData = templateSchema.extend({
	head_version_no: z.number().int(),
});

const upsertChange = z.object({
	seq: z.string(),
	entity: z.literal("template"),
	op: z.literal("upsert"),
	data: templateChangeData,
});

const deleteChange = z.object({
	seq: z.string(),
	entity: z.enum(["template", "dataset", "profile", "setting", "font"]),
	op: z.literal("delete"),
	id: z.string(),
});

export const changeSchema = z.discriminatedUnion("op", [upsertChange, deleteChange]);

export const changesResponse = z.object({
	changes: z.array(changeSchema),
	next_cursor: z.string(),
	has_more: z.boolean(),
	reset: z.boolean(),
});

export const manifestItemSchema = z.object({
	id: z.string().uuid(),
	revision: z.number().int(),
	state: z.enum(["published", "withdrawn", "deleted"]),
	owner_handle: z.string(),
	updated_at: z.string().datetime(),
});

export const manifestResponse = z.object({
	items: z.array(manifestItemSchema),
});

export type SyncChangeResponse = z.infer<typeof changeSchema>;
export type ManifestItemResponse = z.infer<typeof manifestItemSchema>;
