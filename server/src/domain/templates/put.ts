import {
  ForbiddenError,
  RemoteReferenceError,
  RevisionConflictError,
  RevisionRequiredError,
} from "../errors.js";
import type {
  TemplateRepository,
  TemplateView,
  VersionWrite,
} from "../templatePorts.js";
import {
  assertSizeCaps,
  findRemoteRefs,
  type RemoteRefIssue,
} from "./shared.js";

export interface PutTemplateInput {
  id: string;
  name: string;
  summary?: string;
  pageWMm: number;
  pageHMm: number;
  language?: string;
  body: string;
  css?: string;
  readme?: string;
  ifRevision?: number;
  version?: {
    createdBy?: "manual" | "autosave";
    label?: string;
    note?: string;
  };
}

export interface PutTemplateResult {
  template: TemplateView;
  /** 201 when created, 200 when updated or replayed. */
  status: 201 | 200;
  /** True when a stale if_revision matched identical content and
   * nothing was written. */
  replayed: boolean;
}

/**
 * Creates or updates a template by client UUID. Visibility is never part
 * of this call (publish/unpublish own it); creates are always private.
 * Stale revisions conflict unless the content is identical, in which
 * case the lost response is replayed without writing anything.
 * Updating without if_revision is a 428; a duplicate id racing a create
 * reports the same, so the caller retries as an update.
 */
export async function putTemplate(
  repos: { templates: TemplateRepository },
  input: PutTemplateInput,
  ownerId: string,
): Promise<PutTemplateResult> {
  const summary = (input.summary ?? "").trim();
  const css = input.css ?? null;
  const readme = input.readme ?? null;
  assertSizeCaps(input.body, css ?? "", readme ?? "");

  const refs: RemoteRefIssue[] = findRemoteRefs(input.body, css ?? "");
  if (refs.length > 0) {
    throw new RemoteReferenceError(
      refs.map((issue) => ({ path: issue.part, message: issue.snippet })),
    );
  }

  const existing = await repos.templates.findById(input.id);
  if (!existing) {
    const template = await repos.templates.create(
      {
        id: input.id,
        ownerId,
        name: input.name.trim(),
        summary,
        pageWMm: input.pageWMm,
        pageHMm: input.pageHMm,
        language: input.language ?? "html",
        body: input.body,
        css: css ?? "",
        readme: readme ?? "",
      },
      toVersionWrite(input.version),
    );
    return { template, status: 201, replayed: false };
  }

  if (existing.ownerId !== ownerId) {
    throw new ForbiddenError();
  }
  if (input.ifRevision === undefined) {
    throw new RevisionRequiredError();
  }

  const effectiveCss = css ?? existing.css;
  const contentSame =
    input.body === existing.body && effectiveCss === existing.css;
  if (input.ifRevision !== existing.revision) {
    if (contentSame) {
      return { template: existing, status: 200, replayed: true };
    }
    throw new RevisionConflictError(existing.revision);
  }

  const template = await repos.templates.update(
    {
      id: input.id,
      ownerId,
      name: input.name.trim(),
      summary: input.summary === undefined ? existing.summary : summary,
      pageWMm: input.pageWMm,
      pageHMm: input.pageHMm,
      language: input.language ?? existing.language,
      body: input.body,
      css: input.css === undefined ? existing.css : effectiveCss,
      readme: input.readme === undefined ? existing.readme : (readme ?? ""),
    },
    input.ifRevision,
    contentSame ? null : toVersionWrite(input.version),
  );
  return { template, status: 200, replayed: false };
}

function toVersionWrite(version: PutTemplateInput["version"]): VersionWrite {
  return {
    createdBy: version?.createdBy ?? "manual",
    ...(version?.label !== undefined ? { label: version.label } : {}),
    ...(version?.note !== undefined ? { note: version.note } : {}),
  };
}
