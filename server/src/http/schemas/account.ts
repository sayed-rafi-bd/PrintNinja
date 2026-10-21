import { z } from "zod";

export const settingKeyParams = z.object({
  key: z.string().min(1).max(64),
});

export const putSettingBody = z.object({
  value: z.string().max(65_536),
});

export const settingSchema = z.object({
  key: z.string(),
  value: z.string(),
  revision: z.number().int(),
  /** Format: date-time */
  updated_at: z.string().datetime(),
});

export const fontIdParams = z.object({
  id: z.string().uuid(),
});

export const putFontRequest = z.object({
  name: z.string().trim().min(1).max(200),
  if_revision: z.number().int().min(1).optional(),
});

export const fontSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  format: z.string(),
  size_bytes: z.number().int(),
  sha256: z.string(),
  revision: z.number().int(),
  /** Format: date-time */
  created_at: z.string().datetime(),
  /** Format: date-time */
  updated_at: z.string().datetime(),
});
