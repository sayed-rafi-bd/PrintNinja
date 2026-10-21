import {
  ForbiddenError,
  NotFoundError,
  RevisionConflictError,
  RevisionRequiredError,
  ValidationError,
} from "../errors.js";
import type { Page } from "../pagination.js";
import type {
  PageQuery,
  TemplateRepository,
  VersionSummaryView,
  VersionView,
} from "../templatePorts.js";

/**
 * Endpoints 17-20: version list, read, restore and delete. Versions are
 * owner-only — even a published template's history is not public — so
 * every call starts with the same missing/foreign checks as the
 * template itself.
 */
async function ownedTemplate(
  repos: { templates: TemplateRepository },
  id: string,
  ownerId: string,
) {
  const template = await repos.templates.findById(id);
  if (!template) {
    throw new NotFoundError();
  }
  if (template.ownerId !== ownerId) {
    throw new ForbiddenError();
  }
  return template;
}

export async function listVersions(
  repos: { templates: TemplateRepository },
  id: string,
  ownerId: string,
  query: PageQuery,
): Promise<Page<VersionSummaryView>> {
  await ownedTemplate(repos, id, ownerId);
  return repos.templates.listVersions(id, query);
}

export async function readVersion(
  repos: { templates: TemplateRepository },
  id: string,
  versionNo: number,
  ownerId: string,
): Promise<VersionView> {
  await ownedTemplate(repos, id, ownerId);
  const version = await repos.templates.findVersion(id, versionNo);
  if (!version) {
    throw new NotFoundError();
  }
  return version;
}

export interface RestoreResult {
  template: import("../templatePorts.js").TemplateView;
  replayed: boolean;
}

/**
 * Copies a version's body and CSS into the template as a new revision
 * and records a restore version, so no history is lost. Needs
 * if_revision (428 without, 409 on stale); a stale revision whose
 * content already equals the version replays without writing, exactly
 * like PUT.
 */
export async function restoreVersion(
  repos: { templates: TemplateRepository },
  id: string,
  versionNo: number,
  ownerId: string,
  ifRevision: number | undefined,
): Promise<RestoreResult> {
  const template = await ownedTemplate(repos, id, ownerId);
  const version = await repos.templates.findVersion(id, versionNo);
  if (!version) {
    throw new NotFoundError();
  }
  if (ifRevision === undefined) {
    throw new RevisionRequiredError();
  }
  if (ifRevision !== template.revision) {
    if (template.body === version.body && template.css === version.css) {
      return { template, replayed: true };
    }
    throw new RevisionConflictError(template.revision);
  }
  const restored = await repos.templates.update(
    {
      id: template.id,
      ownerId: template.ownerId,
      name: template.name,
      summary: template.summary,
      pageWMm: template.pageWMm,
      pageHMm: template.pageHMm,
      language: template.language,
      body: version.body,
      css: version.css,
      readme: template.readme,
    },
    ifRevision,
    { createdBy: "restore" },
  );
  return { template: restored, replayed: false };
}

/**
 * Deletes one version. The head is never deleted (400); deleting
 * history changes no content, so the revision stands still.
 */
export async function deleteVersion(
  repos: { templates: TemplateRepository },
  id: string,
  versionNo: number,
  ownerId: string,
): Promise<void> {
  await ownedTemplate(repos, id, ownerId);
  const outcome = await repos.templates.deleteVersion(id, versionNo);
  if (outcome === "missing") {
    throw new NotFoundError();
  }
  if (outcome === "newest") {
    throw new ValidationError("The newest version cannot be deleted", [
      { path: "version_no", message: String(versionNo) },
    ]);
  }
}
