import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { agent } from "@/lib/agent/commands";
import * as share from "@/lib/share/client";

export interface ConflictedRow {
  id: number;
  server_id: string | null;
  name: string;
}

/**
 * Resolve a row left in the conflict state (for example by the old
 * background engine): another PC changed it on the server and this PC's
 * push was refused with 409.
 * - Keep mine: the local content becomes a draft again; the next Save
 *   sends it against the server's current revision (which stays in
 *   version history).
 * - Take server: the local edits are discarded for the server copy.
 * - Keep both: the local content becomes a new template, then the
 *   original takes the server copy.
 */
export function ConflictDialog({
  conflict,
  position,
  onOpenChange,
  onResolved,
}: {
  conflict: ConflictedRow | null;
  /** 0-based position in the conflict queue, for "2 of 5" labelling. */
  position?: { index: number; total: number } | null;
  onOpenChange: (open: boolean) => void;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const serverId = conflict?.server_id ?? null;

  const run = async (action: string, fn: () => Promise<void>) => {
    setBusy(action);
    setError("");
    try {
      await fn();
      // The parent advances to the next conflict (or closes): the
      // dialog stays mounted so a queue of N resolves without flashing.
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const keepMine = () =>
    run("mine", async () => {
      if (!serverId) throw new Error("This template was never on the server");
      // Rebase onto the server's current revision so the next Save
      // overwrites cleanly; the other PC's edit stays in version history.
      const remote = await share.fetchRemoteTemplate(serverId);
      await agent("cache_resolve_conflict", {
        server_id: serverId,
        resolution: "mine",
        rebase_to: remote.revision,
      });
    });

  const takeServer = () =>
    run("theirs", async () => {
      if (!serverId) throw new Error("This template was never on the server");
      const remote = await share.fetchRemoteTemplate(serverId);
      await agent("cache_resolve_conflict", {
        server_id: serverId,
        resolution: "theirs",
        server_copy: {
          id: remote.id,
          name: remote.name,
          summary: remote.summary ?? "",
          page_w_mm: remote.page_w_mm,
          page_h_mm: remote.page_h_mm,
          body: remote.body,
          css: remote.css ?? "",
          readme: remote.readme ?? "",
          revision: remote.revision,
          published_at: remote.published_at,
          updated_at: remote.updated_at,
        },
      });
    });

  const keepBoth = () =>
    run("both", async () => {
      if (!serverId || !conflict)
        throw new Error("This template was never on the server");
      const local = await agent("get_template", { id: conflict.id });
      const versions = await agent("list_versions", {
        template_id: conflict.id,
      });
      const latest = versions[0] ?? { html: "", css: "" };
      await agent("create_template", {
        req: {
          name: `${local.name} (copy)`,
          page_w_mm: local.page_w_mm,
          page_h_mm: local.page_h_mm,
          orientation: local.orientation,
          html: latest.html,
          css: latest.css,
          readme: local.readme,
          summary: local.summary,
        },
      });
      const remote = await share.fetchRemoteTemplate(serverId);
      await agent("cache_resolve_conflict", {
        server_id: serverId,
        resolution: "theirs",
        server_copy: {
          id: remote.id,
          name: remote.name,
          summary: remote.summary ?? "",
          page_w_mm: remote.page_w_mm,
          page_h_mm: remote.page_h_mm,
          body: remote.body,
          css: remote.css ?? "",
          readme: remote.readme ?? "",
          revision: remote.revision,
          published_at: remote.published_at,
          updated_at: remote.updated_at,
        },
      });
    });

  return (
    <Dialog open={conflict !== null} onOpenChange={onOpenChange}>
      <DialogContent data-testid="conflict-dialog">
        <DialogHeader>
          <DialogTitle>
            “{conflict?.name}” changed on another PC
            {position && position.total > 1
              ? ` (${position.index + 1} of ${position.total})`
              : ""}
          </DialogTitle>
          <DialogDescription>
            Your edits and the server copy disagree. Take the server copy, keep
            pushing yours, or keep both. Keeping yours is safe: the other PC's
            version stays in history.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button
            data-testid="conflict-keep-mine"
            onClick={keepMine}
            disabled={busy !== null}
          >
            {busy === "mine" ? "Keeping…" : "Keep mine"}
          </Button>
          <Button
            data-testid="conflict-take-server"
            variant="outline"
            onClick={takeServer}
            disabled={busy !== null}
          >
            {busy === "theirs" ? "Applying…" : "Take server"}
          </Button>
          <Button
            data-testid="conflict-keep-both"
            variant="outline"
            onClick={keepBoth}
            disabled={busy !== null}
          >
            {busy === "both" ? "Copying…" : "Keep both"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
