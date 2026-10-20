/**
 * Template sync — Save, Refresh and Get from server (MIGRATION_PLAN.md phase 1).
 *
 * Editing happens on the local copy, exactly as it did before. These functions
 * push that local copy to the server and pull it back; nothing here runs while
 * printing. The server copy is reached through the local row's `remote_id`.
 */
import { invoke } from "@/lib/invoke";
import { compiledFields } from "@/lib/templates/compileTemplateCss";
import { ApiError } from "@/lib/api/errors";
import {
  fetchMyRemoteTemplates,
  fetchRemoteTemplate,
  fetchSavedRemoteTemplates,
  publishRemoteTemplate,
  putRemoteTemplate,
  unpublishRemoteTemplate,
  type RemoteTemplate,
  type RemoteTemplateSummary,
} from "./client";

/** The local row, as far as sync is concerned. */
export interface SyncTemplate {
  id: number;
  name: string;
  summary: string;
  page_w_mm: number;
  page_h_mm: number;
  readme: string;
  remote_id: string | null;
  /** The sync identity minted at creation; the only id pushes may use. */
  server_id: string | null;
  published_at: string | null;
  origin: string;
  origin_owner: string | null;
}

interface TemplateVersion {
  id: number;
  html: string;
  css: string;
}

export type LocalOrigin = "own" | "saved";

/** Saved (community) copies are read-only: no editing, no Save, no Publish. */
export function isReadOnly(template: Pick<SyncTemplate, "origin">): boolean {
  return template.origin === "saved";
}

export function getLocalTemplate(id: number): Promise<SyncTemplate> {
  return invoke<SyncTemplate>("get_template", { id });
}

/** The version the local row points at, which is where editing happens. */
async function getCurrentVersion(templateId: number): Promise<{ html: string; css: string }> {
  const versions = await invoke<TemplateVersion[]>("list_versions", { template_id: templateId });
  const current = versions?.[0];
  if (!current) return { html: "", css: "" };
  return { html: current.html ?? "", css: current.css ?? "" };
}

export interface SaveResult {
  remoteId: string;
  /** The server's timestamp for the copy it now holds. */
  updatedAt: string;
  /** True when the copy on the server is visible to everyone. */
  published: boolean;
}

export interface SaveOptions {
  /** `true` publishes, `false` keeps it private, omitted leaves it as it is. */
  publish?: boolean;
  /** A labelled save records a server version alongside the content. */
  version?: { label?: string | null; note?: string | null };
}

/**
 * Push the current local version to the server. A template that was never
 * saved is created private; an existing one keeps the visibility it has
 * unless asked otherwise. The push always uses the row's own server id
 * (never a fresh UUID), so the engine and this path share one identity
 * and never create duplicates. The server revision is read first, since
 * the local row does not track it yet (the sync engine will); a
 * concurrent edit elsewhere fails here with a revision conflict instead
 * of silently overwriting it. The push is recorded locally so the next
 * engine push bases on the new revision instead of 409ing.
 */
export async function saveToServer(
  template: SyncTemplate,
  options: SaveOptions = {},
): Promise<SaveResult> {
  const { html, css } = await getCurrentVersion(template.id);
  const body = {
    name: template.name,
    summary: template.summary ?? "",
    page_w_mm: template.page_w_mm,
    page_h_mm: template.page_h_mm,
    language: "html" as const,
    body: html,
    css,
    readme: template.readme ?? "",
  };
  let remote: RemoteTemplate;
  // Either id means pushed: server_id is the sync identity, remote_id the
  // legacy column (kept in sync by set_publish_info below).
  const serverRef = template.server_id ?? template.remote_id;
  if (!serverRef) {
    const remoteId = crypto.randomUUID();
    remote = await putRemoteTemplate({ id: remoteId, ...body, ...(options.version ? { version: options.version } : {}) });
    if (options.publish === true) {
      remote = await publishRemoteTemplate(remote.id);
    }
  } else {
    const current = await fetchRemoteTemplate(serverRef);
    try {
      remote = await putRemoteTemplate({
        id: serverRef,
        ...body,
        if_revision: current.revision,
        ...(options.version ? { version: options.version } : {}),
      });
    } catch (err) {
      // A fuller conflict dialog arrives with the sync engine; until then,
      // say what happened in words the toast can show.
      if (err instanceof ApiError && err.code === "revision_conflict") {
        throw new Error("Changed on another PC — refresh and try again");
      }
      throw err;
    }
    if (options.publish === true && !remote.published_at) {
      remote = await publishRemoteTemplate(remote.id);
    } else if (options.publish === false && remote.published_at) {
      await unpublishRemoteTemplate(remote.id);
      remote = { ...remote, published_at: null };
    }
  }
  const updatedAt = remote.updated_at;
  const isPublished = remote.published_at != null;
  const storedId = remote.id;
  // The push is recorded so the next engine push bases on the new
  // revision instead of 409ing on the stale one.
  await invoke("cache_mark_pushed", { server_id: storedId, revision: remote.revision });
  // The local copy and the server copy now agree. A published template records the
  // moment the server copy was published; a private one has no publish time at all.
  await invoke("set_publish_info", {
    req: { id: template.id, remote_id: storedId, published_at: isPublished ? updatedAt : null },
  });
  return { remoteId: storedId, updatedAt, published: isPublished };
}

export interface RefreshResult {
  template: RemoteTemplate;
  name: string;
  page_w_mm: number;
  page_h_mm: number;
}

/**
 * Pull the server copy over the local one. Everything is fetched before anything
 * is written, so a failed fetch leaves the local copy as it was.
 */
export async function refreshFromServer(template: SyncTemplate): Promise<RefreshResult> {
  const serverRef = template.server_id ?? template.remote_id;
  if (!serverRef) {
    throw new Error("This template is not on the server yet. Save it first.");
  }
  const remote = await fetchRemoteTemplate(serverRef);

  await invoke("create_version", {
    req: {
      template_id: template.id,
      html: remote.body ?? "",
      css: remote.css ?? "",
      ...(await compiledFields(remote.body ?? "")),
      label: "Refreshed from server",
      note: null,
      created_by: "sync",
    },
  });
  await invoke("update_readme", { req: { id: template.id, readme: remote.readme ?? "" } });
  await invoke("update_template_meta", {
    req: {
      id: template.id,
      name: remote.name,
      page_w_mm: Math.round(remote.page_w_mm),
      page_h_mm: Math.round(remote.page_h_mm),
      summary: remote.summary ?? "",
    },
  });
  // Local content now matches the server copy, so both timestamps move together and
  // the "changes not saved" badge clears until the next local edit. A template that
  // is private on the server stays private here too.
  await invoke("set_publish_info", {
    req: {
      id: template.id,
      remote_id: remote.id,
      published_at: remote.published_at ? remote.updated_at : null,
    },
  });

  return {
    template: remote,
    name: remote.name,
    page_w_mm: Math.round(remote.page_w_mm),
    page_h_mm: Math.round(remote.page_h_mm),
  };
}

export interface DownloadResult {
  id: number;
  /** False when the template was already on this PC. */
  created: boolean;
}

/** The templates a signed-in user can put on a new PC: their own, and saved ones. */
export async function listAvailableRemoteTemplates(): Promise<{
  mine: RemoteTemplateSummary[];
  saved: RemoteTemplateSummary[];
}> {
  const [mine, saved] = await Promise.all([fetchMyRemoteTemplates(), fetchSavedRemoteTemplates()]);
  return { mine, saved };
}

/** Put a server template on this PC as a local copy, CSS and README included. */
export async function downloadToLocal(
  remoteId: string,
  origin: LocalOrigin = "own",
  originOwner?: string,
): Promise<DownloadResult> {
  const remote = await fetchRemoteTemplate(remoteId);

  const existing = await invoke<SyncTemplate[]>("list_templates");
  const already = (existing ?? []).find((t) => t.remote_id === remoteId);
  if (already) return { id: already.id, created: false };

  let created;
  try {
    created = await invoke<SyncTemplate>("create_template", {
      req: {
        name: remote.name,
        page_w_mm: Math.round(remote.page_w_mm),
        page_h_mm: Math.round(remote.page_h_mm),
        orientation: remote.page_w_mm > remote.page_h_mm ? "landscape" : "portrait",
        html: remote.body ?? "",
        css: remote.css ?? "",
        ...(await compiledFields(remote.body ?? "")),
        readme: remote.readme ?? "",
        summary: remote.summary ?? "",
      },
    });
  } catch (e) {
    throw new Error(`Could not add “${remote.name}” on this PC: ${String(e)}`);
  }

  await invoke("set_publish_info", {
    req: { id: created.id, remote_id: remote.id, published_at: remote.updated_at },
  });
  if (origin === "saved") {
    await invoke("update_template_origin", {
      req: { id: created.id, origin, origin_owner: originOwner ?? remote.owner_handle },
    });
  }
  return { id: created.id, created: true };
}