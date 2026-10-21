import { ForbiddenError, ValidationError } from "./errors.js";
import type { SettingRepository, SettingView } from "./libraryPorts.js";

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

export function isAllowedSettingKey(key: string): key is AllowedSettingKey {
  return (ALLOWED_SETTING_KEYS as readonly string[]).includes(key);
}

export async function putSetting(
  repos: { settings: SettingRepository },
  ownerId: string,
  key: string,
  value: string,
): Promise<SettingView> {
  if (!isAllowedSettingKey(key)) {
    throw new ValidationError(`Unknown setting '${key}'`, [
      { path: "key", message: "Not an account preference" },
    ]);
  }
  const existing = await repos.settings.findByKey(ownerId, key);
  if (!existing) {
    return repos.settings.create({ ownerId, key, value });
  }
  if (existing.ownerId !== ownerId) {
    throw new ForbiddenError();
  }
  return repos.settings.update({ ownerId, key, value }, existing.revision);
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
