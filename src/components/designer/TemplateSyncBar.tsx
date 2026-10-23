import { useState } from "react";
import { ArrowDownToLine } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";

interface Props {
  templateName: string;
  remoteId: string | null;
  publishedAt: string | null;
  /** Saved (community) copies are read-only: actions are hidden. */
  readOnly?: boolean;
  /** The action running right now, so only its button says so. */
  pending: "save" | "publish" | "unpublish" | "sync" | null;
  onPublish: () => void;
  onUnpublish: () => void | Promise<void>;
  onCacheNow: () => void;
}

/**
 * Where the local copy stands with the server. Saving happens in the
 * Designer toolbar (a manual, blocking push); this bar holds the
 * one-time Publish/Unpublish switch and a cache refresh. Nothing here
 * sends automatically.
 */
export function TemplateSyncBar({
  templateName,
  remoteId,
  publishedAt,
  readOnly = false,
  pending,
  onPublish,
  onUnpublish,
  onCacheNow,
}: Props) {
  const [unpublishOpen, setUnpublishOpen] = useState(false);
  const busy = pending != null;
  const published = !!remoteId && !!publishedAt;

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
        <div
          className="flex items-center gap-2"
          data-testid="template-state"
          data-state={
            readOnly ? "read-only" : published ? "published" : "draft"
          }
        >
          {state}
          {!readOnly && !remoteId && (
            <span className="text-xs text-muted-foreground">
              Only on this computer
            </span>
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
              <Button
                data-testid="template-publish"
                variant="outline"
                size="sm"
                onClick={onPublish}
                disabled={busy}
              >
                {pending === "publish" ? "Publishing…" : "Publish to Community"}
              </Button>
            )}
            <Button
              data-testid="template-sync-now"
              variant="outline"
              size="sm"
              onClick={onCacheNow}
              disabled={busy}
            >
              <ArrowDownToLine className="h-4 w-4" aria-hidden="true" />
              {pending === "sync" ? "Refreshing…" : "Refresh cache"}
            </Button>
          </div>
        )}
      </div>

      {readOnly && (
        <p role="status" className="text-xs text-muted-foreground">
          This is a saved copy from another person. You can print it, but not
          change it.
        </p>
      )}
      {!readOnly && remoteId && !published && (
        <p role="status" className="text-xs text-muted-foreground">
          Saved on the server as a private copy. Publish to show it in
          Community.
        </p>
      )}
      {!readOnly && published && (
        <p role="status" className="text-xs text-muted-foreground">
          Published — Save updates the live copy, no need to publish again.
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
