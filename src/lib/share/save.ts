/**
 * Server-authoritative save and delete for templates.
 *
 * The server owns the copy of record. Saving is a manual, synchronous
 * action: these functions push the editor's content straight to the
 * server and, once it accepts, record that accepted copy in the local
 * cache (marking the row synced at the new revision). Nothing here runs
 * in the background, so a change can never sit invisibly waiting to be
 * sent — either the server has it, or the user sees the failure.
 *
 * The local cache is written *before* the push so an edit is never lost:
 * a failed save leaves the row as a visible draft (counted in the shell
 * and Settings) that the next Save retries.
 */
import { agent } from "@/lib/agent/commands";
import type { TemplateRow } from "@/lib/agent/types";
import { ApiError, storedRevision } from "@/lib/api/errors";
import { compiledFields } from "@/lib/templates/compileTemplateCss";
import {
  fetchRemoteTemplate,
  putRemoteTemplate,
  RemoteTemplateNotFoundError,
  unpublishTemplate,
  type RemoteTemplate,
} from "./client";

/** The content being saved: the editor's current state for one template. */
export interface TemplateContent {
  name: string;
  summary: string;
  page_w_mm: number;
  page_h_mm: number;
  html: string;
  css: string;
  readme: string;
}

/**
 * The server refused the save because its copy moved since this PC last
 * synced it. Carries the server's current revision so the dialog can
 * offer an informed overwrite.
 */
export class TemplateConflictError extends Error {
  constructor(
    public readonly serverId: string,
    public readonly storedRevision: number | null,
  ) {
    super("This template changed on the server since you last saved it");
    this.name = "TemplateConflictError";
  }
}

export interface SaveOutcome {
  remoteId: string;
  revision: number;
  updatedAt: string;
  published: boolean;
}

/**
 * Save one template to the server, then cache the accepted copy.
 *
 * The editor snapshot lands locally first (validating remote refs with
 * the canonical message), then the PUT guarded by the row's own
 * revision: a 409 becomes a `TemplateConflictError` for the user to
 * resolve, never a silent overwrite. A template the server has never
 * seen is created. A 428 means the guard is fictional — either a create
 * whose response was lost (retry as an update) or an id the server
 * never saw (retry as a create).
 */
export async function saveTemplateToServer(
  template: TemplateRow,
  content: TemplateContent,
): Promise<SaveOutcome> {
  const serverId =
    template.server_id ?? template.remote_id ?? crypto.randomUUID();

  const compiled = await compiledFields(content.html);

  const body = {
    name: content.name,
    summary: content.summary,
    page_w_mm: content.page_w_mm,
    page_h_mm: content.page_h_mm,
    language: "html" as const,
    body: content.html,
    css: content.css,
    readme: content.readme,
  };

  const put = (ifRevision: number | undefined) =>
    putRemoteTemplate({
      id: serverId,
      ...body,
      ...(ifRevision === undefined ? {} : { if_revision: ifRevision }),
    });

  let remote: RemoteTemplate;
  try {
    remote = await put(template.base_revision ?? undefined);
  } catch (err) {
    if (err instanceof ApiError && err.code === "revision_required") {
      // The server wants a guard this PC cannot supply. Usually that is
      // a create whose response was lost (retry as an update); but when
      // the server never saw the id at all — a seeded or migrated row
      // with a fictional base — the recovery is a create instead.
      const current = await fetchRemoteTemplate(serverId).catch(
        (e: unknown) => {
          if (e instanceof RemoteTemplateNotFoundError) return null;
          throw e;
        },
      );
      try {
        remote = await put(current?.revision);
      } catch (retryErr) {
        throw asConflict(serverId, retryErr);
      }
    } else {
      throw asConflict(serverId, err);
    }
  }

  await recordServerCopy(template, content, remote, compiled);
  return {
    remoteId: remote.id,
    revision: remote.revision,
    updatedAt: remote.updated_at,
    published: remote.published_at != null,
  };
}

function asConflict(serverId: string, err: unknown): unknown {
  if (err instanceof ApiError && err.code === "revision_conflict") {
    return new TemplateConflictError(serverId, storedRevision(err));
  }
  return err;
}

/**
 * Write the copy the server just accepted into the local cache: the
 * metadata, the README, and the sync bookkeeping that marks the row
 * synced at that revision. (The version snapshot itself was written
 * before the PUT, so a failed save still leaves the attempt in history
 * as a visible draft.) This is what makes the cache mirror the server
 * instead of leading it.
 */
async function recordServerCopy(
  template: TemplateRow,
  content: TemplateContent,
  remote: RemoteTemplate,
  compiled?: { compiled_css?: string; compiled_key?: string },
): Promise<void> {
  await agent("update_template_meta", {
    req: {
      id: template.id,
      name: content.name,
      page_w_mm: content.page_w_mm,
      page_h_mm: content.page_h_mm,
      summary: content.summary,
      html: content.html,
      css: content.css,
      compiled_css: compiled?.compiled_css ?? "",
      compiled_key: compiled?.compiled_key ?? "",
    },
  });
  await agent("update_readme", {
    req: { id: template.id, readme: content.readme },
  });
  await agent("cache_mark_pushed", {
    server_id: remote.id,
    revision: remote.revision,
  });
  await agent("set_publish_info", {
    req: {
      id: template.id,
      remote_id: remote.id,
      published_at: remote.published_at ? remote.updated_at : null,
    },
  });
}

/**
 * Create a template server-first: PUT the starter content (a private
 * copy), then write the local row with the server's id and revision so
 * it starts synced. The caller must be online — offline there is no
 * creation, only viewing and printing.
 */
export async function createTemplateOnServer(input: {
  name: string;
  page_w_mm: number;
  page_h_mm: number;
  orientation: string;
  html: string;
  css: string;
}): Promise<TemplateRow> {
  const remote = await putRemoteTemplate({
    id: crypto.randomUUID(),
    name: input.name,
    summary: "",
    page_w_mm: input.page_w_mm,
    page_h_mm: input.page_h_mm,
    language: "html" as const,
    body: input.html,
    css: input.css,
    readme: "",
  });
  const created = await agent("create_template", {
    req: {
      name: remote.name,
      page_w_mm: Math.round(remote.page_w_mm),
      page_h_mm: Math.round(remote.page_h_mm),
      orientation: input.orientation,
      html: input.html,
      css: input.css,
      ...(await compiledFields(input.html)),
      readme: remote.readme ?? "",
      summary: remote.summary ?? "",
      server_id: remote.id,
      server_revision: remote.revision,
      base_revision: remote.revision,
      sync_state: "synced",
    },
  });
  await agent("set_publish_info", {
    req: {
      id: created.id,
      remote_id: remote.id,
      published_at: null,
    },
  });
  return created;
}

/**
 * Save a row from a list (no editor open): builds the content from the
 * row and its current version, then saves. Used by the Templates list
 * for draft rows; the Designer builds content from its editor instead.
 */
export async function saveRowToServer(
  template: TemplateRow,
): Promise<SaveOutcome> {
  return saveTemplateToServer(template, {
    name: template.name,
    summary: template.summary ?? "",
    page_w_mm: template.page_w_mm,
    page_h_mm: template.page_h_mm,
    html: template.html ?? "",
    css: template.css ?? "",
    readme: template.readme ?? "",
  });
}

/** Resolve a save conflict by overwriting the server with this PC's copy.
 * It rebases onto the server's current revision so the overwrite is
 * explicit and guarded — if the server moves again meanwhile, the user
 * is warned rather than silently clobbering a third change. */
export async function overwriteWithMine(
  template: TemplateRow,
  content: TemplateContent,
): Promise<SaveOutcome> {
  const serverId = template.server_id ?? template.remote_id;
  if (!serverId) throw new Error("This template is not on the server yet");
  const current = await fetchRemoteTemplate(serverId);
  return saveTemplateToServer(
    { ...template, server_id: serverId, base_revision: current.revision },
    content,
  );
}

/**
 * Resolve a save conflict by taking the server's copy: fetch it, write
 * it over the local cache, and mark the row synced. The caller reloads
 * its editor from the returned content.
 */
export async function takeServerCopy(template: TemplateRow): Promise<{
  html: string;
  css: string;
  name: string;
  summary: string;
  readme: string;
  page_w_mm: number;
  page_h_mm: number;
  revision: number;
  updatedAt: string;
}> {
  const serverId = template.server_id ?? template.remote_id;
  if (!serverId) throw new Error("This template is not on the server yet");
  const remote = await fetchRemoteTemplate(serverId);
  const html = remote.body ?? "";
  const compiled = await compiledFields(html);
  await agent("update_template_meta", {
    req: {
      id: template.id,
      name: remote.name,
      page_w_mm: Math.round(remote.page_w_mm),
      page_h_mm: Math.round(remote.page_h_mm),
      summary: remote.summary ?? "",
      html,
      css: remote.css ?? "",
      compiled_css: compiled.compiled_css ?? "",
      compiled_key: compiled.compiled_key ?? "",
    },
  });
  await agent("update_readme", {
    req: { id: template.id, readme: remote.readme ?? "" },
  });
  await agent("cache_mark_pushed", {
    server_id: remote.id,
    revision: remote.revision,
  });
  await agent("set_publish_info", {
    req: {
      id: template.id,
      remote_id: remote.id,
      published_at: remote.published_at ? remote.updated_at : null,
    },
  });
  return {
    html,
    css: remote.css ?? "",
    name: remote.name,
    summary: remote.summary ?? "",
    readme: remote.readme ?? "",
    page_w_mm: Math.round(remote.page_w_mm),
    page_h_mm: Math.round(remote.page_h_mm),
    revision: remote.revision,
    updatedAt: remote.updated_at,
  };
}

/**
 * Delete a template: the server copy first, then the local cache. A
 * template that lives only on this PC (never saved) skips the server.
 * Offline, the caller blocks the action — there is no queue, so a delete
 * cannot be deferred without lying about the result.
 */
export async function deleteTemplateEverywhere(
  template: Pick<TemplateRow, "id" | "server_id" | "remote_id">,
): Promise<void> {
  const serverId = template.server_id ?? template.remote_id;
  if (serverId) {
    // `unpublishTemplate` DELETEs the server copy and treats 404 as
    // already gone — exactly the end state a delete wants.
    await unpublishTemplate(serverId);
  }
  await agent("cache_forget_template", { server_id: serverId ?? "" });
  if (!serverId) {
    // A never-saved template has no server id to forget by; remove the
    // local row directly.
    await agent("delete_template", { id: template.id });
  }
}
