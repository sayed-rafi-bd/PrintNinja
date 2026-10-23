/**
 * Template reads — Get from server and the row helpers behind it.
 *
 * The server owns the copies. Saving and deleting go through
 * `./save` (manual, synchronous pushes); this module only reads:
 * listing what is available, downloading a copy, and the predicates the
 * UI needs. Nothing here runs while printing.
 */
import { agent } from "@/lib/agent/commands";
import type { TemplateRow } from "@/lib/agent/types";
import { compiledFields } from "@/lib/templates/compileTemplateCss";
import {
  fetchMyRemoteTemplates,
  fetchRemoteTemplate,
  fetchSavedRemoteTemplates,
  type RemoteTemplateSummary,
} from "./client";

export type LocalOrigin = "own" | "saved";

/** Saved (community) copies are read-only: no editing, no Save, no Publish. */
export function isReadOnly(template: Pick<TemplateRow, "origin">): boolean {
  return template.origin === "saved";
}

export function getLocalTemplate(id: number): Promise<TemplateRow> {
  return agent("get_template", { id });
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
  const [mine, saved] = await Promise.all([
    fetchMyRemoteTemplates(),
    fetchSavedRemoteTemplates(),
  ]);
  return { mine, saved };
}

/** Put a server template on this PC as a local copy, CSS and README included. */
export async function downloadToLocal(
  remoteId: string,
  origin: LocalOrigin = "own",
  originOwner?: string,
): Promise<DownloadResult> {
  const remote = await fetchRemoteTemplate(remoteId);

  const existing = await agent("list_templates", {});
  const already = (existing ?? []).find(
    (t) => t.remote_id === remoteId || t.server_id === remoteId,
  );
  if (already) return { id: already.id, created: false };

  let created;
  try {
    // A downloaded copy arrives synced at the server's revision: the
    // engine must not push it back as a new own template, and a later
    // pull refreshes it instead of duplicating it.
    created = await agent("create_template", {
      req: {
        name: remote.name,
        page_w_mm: Math.round(remote.page_w_mm),
        page_h_mm: Math.round(remote.page_h_mm),
        orientation:
          remote.page_w_mm > remote.page_h_mm ? "landscape" : "portrait",
        html: remote.body ?? "",
        css: remote.css ?? "",
        ...(await compiledFields(remote.body ?? "")),
        readme: remote.readme ?? "",
        summary: remote.summary ?? "",
        server_id: remote.id,
        sync_state: "synced",
        server_revision: remote.revision,
        base_revision: remote.revision,
        kind: origin,
        owner_handle:
          origin === "saved" ? (originOwner ?? remote.owner_handle) : null,
      },
    });
  } catch (e) {
    throw new Error(`Could not add “${remote.name}” on this PC: ${String(e)}`);
  }

  await agent("set_publish_info", {
    req: {
      id: created.id,
      remote_id: remote.id,
      published_at: remote.updated_at,
    },
  });
  if (origin === "saved") {
    await agent("update_template_origin", {
      req: {
        id: created.id,
        origin,
        origin_owner: originOwner ?? remote.owner_handle,
      },
    });
  }
  return { id: created.id, created: true };
}
