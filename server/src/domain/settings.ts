import {
  ForbiddenError,
  PayloadTooLargeError,
  ValidationError,
} from "./errors.js";
import type { SettingRepository, SettingView } from "./libraryPorts.js";

/** Mirror the schema char cap in bytes. */
export const SETTING_VALUE_MAX_BYTES = 65_536;

/**
 * Account preferences (REFACTORING.md question 23): only keys on the
 * allow-list live on the server — everything else stays in the local
 * settings table on the device. Unknown keys are refused, never stored.
 */
export const ALLOWED_SETTING_KEYS = [
  "ui_density",
  "brand_name",
  "brand_logo",
] as const;
export type AllowedSettingKey = (typeof ALLOWED_SETTING_KEYS)[number];

export interface PutSettingResult {
  view: SettingView;
  /** 201 when created, 200 when overwritten. */
  status: 201 | 200;
}

export function isAllowedSettingKey(key: string): key is AllowedSettingKey {
  return (ALLOWED_SETTING_KEYS as readonly string[]).includes(key);
}

export async function putSetting(
  repos: { settings: SettingRepository },
  ownerId: string,
  key: string,
  value: string,
): Promise<PutSettingResult> {
  if (!isAllowedSettingKey(key)) {
    throw new ValidationError(`Unknown setting '${key}'`, [
      { path: "key", message: "Not an account preference" },
    ]);
  }
  if (Buffer.byteLength(value, "utf8") > SETTING_VALUE_MAX_BYTES) {
    throw new PayloadTooLargeError([
      {
        path: "value",
        message: `Over the ${SETTING_VALUE_MAX_BYTES} byte cap`,
      },
    ]);
  }
  const existing = await repos.settings.findByKey(ownerId, key);
  if (!existing) {
    const view = await repos.settings.create({ ownerId, key, value });
    return { view, status: 201 };
  }
  if (existing.ownerId !== ownerId) {
    throw new ForbiddenError();
  }
  const view = await repos.settings.update(
    { ownerId, key, value },
    existing.revision,
  );
  return { view, status: 200 };
}

export async function deleteSetting(
  repos: { settings: SettingRepository },
  ownerId: string,
  key: string,
): Promise<void> {
  if (!isAllowedSettingKey(key)) {
    throw new ValidationError(`Unknown setting '${key}'`, [
      { path: "key", message: "Not an account preference" },
    ]);
  }
  const existing = await repos.settings.findByKey(ownerId, key);
  if (!existing) {
    return;
  }
  if (existing.ownerId !== ownerId) {
    throw new ForbiddenError();
  }
  await repos.settings.deleteWithTombstone(ownerId, key);
}
