import { z } from "zod";

export const uuidParams = z.object({
  id: z.string().uuid(),
});

export const putDatasetRequest = z.object({
  name: z.string().trim().min(1).max(200),
  dataJson: z.string().max(262_144).optional(),
  if_revision: z.number().int().min(1).optional(),
});

export const datasetSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  data_json: z.string(),
  revision: z.number().int(),
  /** Format: date-time */
  created_at: z.string().datetime(),
  /** Format: date-time */
  updated_at: z.string().datetime(),
});

export const putProfileRequest = z.object({
  template_id: z.string().uuid(),
  printer_name: z.string().trim().min(1).max(100),
  settings_json: z.string().max(65_536).optional(),
  if_revision: z.number().int().min(1).optional(),
});

export const profileSchema = z.object({
  id: z.string().uuid(),
  template_id: z.string().uuid(),
  printer_name: z.string(),
  settings_json: z.string(),
  revision: z.number().int(),
  /** Format: date-time */
  created_at: z.string().datetime(),
  /** Format: date-time */
  updated_at: z.string().datetime(),
});
