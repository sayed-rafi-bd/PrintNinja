import { useState } from "react";
import { ArrowUpFromLine } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";

interface Props {
  templateName: string;
  remoteId: string | null;
  publishedAt: string | null;
  templateUpdatedAt: string | null;
  /** Saved (community) copies are read-only: actions are hidden. */
  readOnly?: boolean;
  /** The action running right now, so only its button says so. */
  pending: "save" | "publish" | "unpublish" | "sync" | null;
  onPublish: () => void;
  onUnpublish: () => void | Promise<void>;
  onSyncNow: () => void;
}

/**
 * Where the local copy stands with the server: the state, and the three
 * actions that move it — Publish, Unpublish and Sync now. Saving happens
 * locally (the Save button writes a version) and the engine pushes
 * dirty rows in the background, so there is no Save-to-server or
 * Refresh here.
 */
export function TemplateSyncBar({
  templateName,
  remoteId,
  publishedAt,
  templateUpdatedAt,
  readOnly = false,
  pending,
  onPublish,
  onUnpublish,
  onSyncNow,
}: Props) {
  const [unpublishOpen, setUnpublishOpen] = useState(false);
  const busy = pending != null;
  const published = !!remoteId && !!publishedAt;
  const changedLocally = published && !!templateUpdatedAt && new Date(templateUpdatedAt) > new Date(publishedAt);

  const state = readOnly ? (
    <StatusBadge status="saved" label="Read-only copy" />
  ) : published ? (
    <StatusBadge status="published" />
  ) : (
    <StatusBadge status="draft" />
  );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2">
        <div className="flex items-center gap-2" data-testid="template-state" data-state={readOnly ? "read-only" : published ? "published" : "draft"}>
          {state}
          {!readOnly && !remoteId && (
            <span className="text-xs text-muted-foreground">Only on this computer</span>
          )}
        </div>
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-2">
            {published ? (
              <Button
                data-testid="template-unpublish"
                variant="outline"
                size="sm"
                onClick={() => setUnpublishOpen(true)}
                disabled={busy}
                className="border-danger/30 text-danger hover:bg-danger-soft hover:text-danger"
              >
                Unpublish
              </Button>
            ) : (
              <Button data-testid="template-publish" variant="outline" size="sm" onClick={onPublish} disabled={busy}>
                {pending === "publish" ? "Publishing…" : "Publish to Community"}
              </Button>
            )}
            <Button data-testid="template-sync-now" variant="outline" size="sm" onClick={onSyncNow} disabled={busy}>
              <ArrowUpFromLine className="h-4 w-4" aria-hidden="true" />
              {pending === "sync" ? "Syncing…" : "Sync now"}
            </Button>
          </div>
        )}
      </div>

      {readOnly && (
        <p role="status" className="text-xs text-muted-foreground">
          This is a saved copy from another person. You can print it, but not change it.
        </p>
      )}
      {!readOnly && changedLocally && publishedAt && (
        <p role="status" className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">
          These changes are not on the server yet. Other people still see the version from{" "}
          {new Date(publishedAt).toLocaleDateString()}. They send automatically.
        </p>
      )}
      {!readOnly && remoteId && !published && (
        <p role="status" className="text-xs text-muted-foreground">
          Saved on the server as a private copy. Publish to show it in Community.
        </p>
      )}

      <ConfirmDialog
        open={unpublishOpen}
        onOpenChange={setUnpublishOpen}
        title={`Unpublish “${templateName}”?`}
        description="It stays on this computer and on the server, but disappears from Community."
        confirmLabel="Unpublish"
        destructive
        busy={pending === "unpublish"}
        onConfirm={async () => {
          await onUnpublish();
          setUnpublishOpen(false);
        }}
      />
    </>
  );
}
