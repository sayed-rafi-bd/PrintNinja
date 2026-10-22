import { createHash } from "node:crypto";
import {
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  QuotaExceededError,
  RevisionConflictError,
  RevisionRequiredError,
  ValidationError,
} from "./errors.js";
import type { FontRepository, FontView, UploadedFont } from "./libraryPorts.js";

/**
 * Fonts (REFACTORING.md question 21, answered): private to the owner,
 * never in published templates, 5 MiB and 50 per user, bytes in
 * PostgreSQL. The format comes from magic bytes, never the extension.
 */
export const FONT_MAX_BYTES = 5 * 1024 * 1024;
export const FONTS_PER_USER_MAX = 50;
/** Mirror the schema char cap in bytes. */
export const FONT_NAME_MAX_BYTES = 200;

export type FontFormat = "ttf" | "otf" | "woff2";

const MAGIC: Array<{ format: FontFormat; prefix: number[] }> = [
  { format: "ttf", prefix: [0x00, 0x01, 0x00, 0x00] },
  { format: "otf", prefix: [0x4f, 0x54, 0x54, 0x4f] }, // OTTO
  { format: "woff2", prefix: [0x77, 0x4f, 0x46, 0x32] }, // wOF2
];

export function detectFontFormat(bytes: Uint8Array): FontFormat | null {
  for (const { format, prefix } of MAGIC) {
    if (prefix.every((b, i) => bytes[i] === b)) {
      return format;
    }
  }
  return null;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface PutFontInput {
  id: string;
  name: string;
  ifRevision?: number;
}

export interface PutFontResult {
  font: FontView;
  status: 201 | 200;
  replayed: boolean;
}

export async function putFont(
  repos: { fonts: FontRepository },
  input: PutFontInput,
  ownerId: string,
): Promise<PutFontResult> {
  const name = input.name.trim();
  if (name.length === 0 || name.length > 200) {
    throw new ValidationError("Font name required (1-200 chars)", [
      { path: "name", message: "Required" },
    ]);
  }
  if (Buffer.byteLength(name, "utf8") > FONT_NAME_MAX_BYTES) {
    throw new PayloadTooLargeError([
      {
        path: "name",
        message: `Over the ${FONT_NAME_MAX_BYTES} byte cap`,
      },
    ]);
  }
  const existing = await repos.fonts.findById(input.id);
  if (!existing) {
    const count = await repos.fonts.countByOwner(ownerId);
    if (count >= FONTS_PER_USER_MAX) {
      throw new QuotaExceededError(
        `at most ${FONTS_PER_USER_MAX} fonts per user`,
      );
    }
    const font = await repos.fonts.create({ id: input.id, ownerId, name });
    return { font, status: 201, replayed: false };
  }
  if (existing.ownerId !== ownerId) {
    throw new ForbiddenError();
  }
  if (input.ifRevision === undefined) {
    throw new RevisionRequiredError();
  }
  if (input.ifRevision !== existing.revision) {
    if (existing.name === name) {
      return { font: existing, status: 200, replayed: true };
    }
    throw new RevisionConflictError(existing.revision);
  }
  const font = await repos.fonts.updateName(
    { id: input.id, ownerId, name },
    input.ifRevision,
  );
  return { font, status: 200, replayed: false };
}

export async function putFontFile(
  repos: { fonts: FontRepository },
  id: string,
  bytes: Uint8Array,
  ownerId: string,
): Promise<UploadedFont> {
  if (bytes.length === 0) {
    throw new ValidationError("Font file is empty", [
      { path: "body", message: "Required" },
    ]);
  }
  if (bytes.length > FONT_MAX_BYTES) {
    throw new PayloadTooLargeError([
      { path: "body", message: `Over the ${FONT_MAX_BYTES} byte cap` },
    ]);
  }
  const format = detectFontFormat(bytes);
  if (!format) {
    throw new ValidationError(
      "Unrecognized font format (need TTF, OTF or WOFF2 magic bytes)",
      [{ path: "body", message: "Wrong content" }],
    );
  }
  const existing = await repos.fonts.findById(id);
  if (!existing) {
    throw new NotFoundError();
  }
  if (existing.ownerId !== ownerId) {
    throw new ForbiddenError();
  }
  return repos.fonts.replaceFile({
    id,
    ownerId,
    bytes,
    format,
    sha256: sha256Hex(bytes),
  });
}

export async function getFontFile(
  repos: { fonts: FontRepository },
  id: string,
  ownerId: string,
): Promise<UploadedFont> {
  const file = await repos.fonts.findFile(id);
  if (!file || file.ownerId !== ownerId) {
    // Missing, or another owner's: indistinguishable, like templates.
    throw new NotFoundError();
  }
  return file;
}

export async function deleteFont(
  repos: { fonts: FontRepository },
  id: string,
  ownerId: string,
): Promise<void> {
  const existing = await repos.fonts.findById(id);
  if (!existing) {
    throw new NotFoundError();
  }
  if (existing.ownerId !== ownerId) {
    throw new ForbiddenError();
  }
  await repos.fonts.deleteWithTombstone(id);
}
