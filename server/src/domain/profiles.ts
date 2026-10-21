import {
  ForbiddenError,
  NotFoundError,
  RevisionConflictError,
  RevisionRequiredError,
  ValidationError,
} from "./errors.js";
import type {
  ProfileRepository,
  ProfileView,
  ProfileWrite,
} from "./libraryPorts.js";

export interface PutProfileInput {
  id: string;
  templateId: string;
  printerName: string;
  settingsJson?: string;
  ifRevision?: number;
}

export interface PutProfileResult {
  profile: ProfileView;
  /** 201 when created, 200 when updated or replayed. */
  status: 201 | 200;
  /** True when a stale if_revision matched identical content and
   * nothing was written. */
  replayed: boolean;
}

function checkWrite(input: PutProfileInput): {
  printerName: string;
  settingsJson: string;
} {
  if (!input.templateId) {
    throw new ValidationError("templateId required", [
      { path: "templateId", message: "Required" },
    ]);
  }
  // Printer names match case-insensitively (question 20): the key is
  // stored lowercase so "E2E Label Printer" and "e2e label printer"
  // address the same profile.
  const printerName = (input.printerName ?? "").trim().toLowerCase();
  if (printerName.length === 0) {
    throw new ValidationError("printerName required", [
      { path: "printerName", message: "Required" },
    ]);
  }
  const settingsJson = input.settingsJson ?? "{}";
  try {
    JSON.parse(settingsJson);
  } catch {
    throw new ValidationError("settings_json is not valid JSON", [
      { path: "settingsJson", message: "Must be valid JSON" },
    ]);
  }
  return { printerName, settingsJson };
}

/**
 * Creates or updates a printer profile by client UUID, keyed by template
 * and (lowercased) printer name. Same revision contract as templates:
 * 428 without if_revision on update, 409 on stale revisions unless the
 * content is identical (replayed).
 */
export async function putProfile(
  repos: { profiles: ProfileRepository },
  input: PutProfileInput,
  ownerId: string,
): Promise<PutProfileResult> {
  const { printerName, settingsJson } = checkWrite(input);
  const write: ProfileWrite = {
    id: input.id,
    ownerId,
    templateId: input.templateId,
    printerName,
    settingsJson,
  };
  const existing = await repos.profiles.findById(input.id);
  if (!existing) {
    const profile = await repos.profiles.create(write);
    return { profile, status: 201, replayed: false };
  }
  if (existing.ownerId !== ownerId) {
    throw new ForbiddenError();
  }
  if (input.ifRevision === undefined) {
    throw new RevisionRequiredError();
  }
  if (input.ifRevision !== existing.revision) {
    if (
      existing.settingsJson === settingsJson &&
      existing.templateId === input.templateId &&
      existing.printerName === printerName
    ) {
      return { profile: existing, status: 200, replayed: true };
    }
    throw new RevisionConflictError(existing.revision);
  }
  const profile = await repos.profiles.update(write, input.ifRevision);
  return { profile, status: 200, replayed: false };
}

export async function deleteProfile(
  repos: { profiles: ProfileRepository },
  id: string,
  ownerId: string,
): Promise<void> {
  const existing = await repos.profiles.findById(id);
  if (!existing) {
    throw new NotFoundError();
  }
  if (existing.ownerId !== ownerId) {
    throw new ForbiddenError();
  }
  await repos.profiles.deleteWithTombstone(id);
}
