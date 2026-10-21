import { z } from "zod";
import { fontSchema, settingSchema } from "./account.js";
import { datasetSchema, profileSchema } from "./library.js";
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

const templateUpsertChange = z.object({
  seq: z.string(),
  entity: z.literal("template"),
  op: z.literal("upsert"),
  data: templateChangeData,
});

const datasetUpsertChange = z.object({
  seq: z.string(),
  entity: z.literal("dataset"),
  op: z.literal("upsert"),
  data: datasetSchema,
});

const profileUpsertChange = z.object({
  seq: z.string(),
  entity: z.literal("profile"),
  op: z.literal("upsert"),
  data: profileSchema,
});

const settingUpsertChange = z.object({
  seq: z.string(),
  entity: z.literal("setting"),
  op: z.literal("upsert"),
  data: settingSchema,
});

const fontUpsertChange = z.object({
  seq: z.string(),
  entity: z.literal("font"),
  op: z.literal("upsert"),
  data: fontSchema,
});

const deleteChange = z.object({
  seq: z.string(),
  entity: z.enum(["template", "dataset", "profile", "setting", "font"]),
  op: z.literal("delete"),
  id: z.string(),
});

export const changeSchema = z.union([
  templateUpsertChange,
  datasetUpsertChange,
  profileUpsertChange,
  settingUpsertChange,
  fontUpsertChange,
  deleteChange,
]);

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
