/** Pure helpers for the density and branding preferences (no React, easy to test). */

export type Density = "comfortable" | "compact";

export const DEFAULT_APP_NAME = "PrintNinja";
export const MAX_APP_NAME_LENGTH = 40;
export const MAX_LOGO_BYTES = 256 * 1024;
export const LOGO_TYPES = [
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/webp",
] as const;

export const SETTING_KEYS = {
  density: "ui_density",
  appName: "brand_name",
  logo: "brand_logo",
} as const;

export function parseDensity(value: string | null | undefined): Density {
  return value === "compact" ? "compact" : "comfortable";
}

/** Trim, collapse whitespace, cap the length. Empty falls back to the default name. */
export function sanitizeAppName(value: string | null | undefined): string {
  const name = (value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_APP_NAME_LENGTH)
    .trim();
  return name || DEFAULT_APP_NAME;
}

/** Only image data URLs of the allowed types are accepted from storage. */
export function isValidLogoDataUrl(
  value: string | null | undefined,
): value is string {
  if (!value) return false;
  return /^data:image\/(png|jpeg|svg\+xml|webp);base64,[A-Za-z0-9+/=]+$/.test(
    value,
  );
}

export type LogoCheck = { ok: true } | { ok: false; message: string };

export function checkLogoFile(file: { type: string; size: number }): LogoCheck {
  if (!(LOGO_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, message: "Use a PNG, JPEG, WebP, or SVG image." };
  }
  if (file.size > MAX_LOGO_BYTES) {
    return {
      ok: false,
      message: `The logo must be ${MAX_LOGO_BYTES / 1024} KB or smaller.`,
    };
  }
  return { ok: true };
}

export function windowTitle(appName: string): string {
  return appName;
}
