import { useState } from "react";
import { CloudUpload, RefreshCw } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";

interface Props {
  templateName: string;
  remoteId: string | null;
  publishedAt: string | null;
  templateUpdatedAt: string | null;
  /** Saved (community) copies are read-only: no Save, no Publish. */
  readOnly?: boolean;
  /** The action running right now, so only its button says so. */
  pending: "save" | "refresh" | "publish" | "unpublish" | null;
  onSave: () => void;
  onRefresh: () => void;
  onPublish: () => void;
  onUnpublish: () => void | Promise<void>;
}

/**
 * Where the local copy stands with the server: the state, and the four actions
 * that move it — Save, Refresh, Publish and Unpublish.
 */
export function TemplateSyncBar({
  templateName,
  remoteId,
  publishedAt,
  templateUpdatedAt,
  readOnly = false,
  pending,
  onSave,
  onRefresh,
  onPublish,
  onUnpublish,
}: Props) {
  const [refreshOpen, setRefreshOpen] = useState(false);
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
        <div className="flex items-center gap-2">
          {state}
          {!readOnly && !remoteId && (
            <span className="text-xs text-muted-foreground">Only on this computer</span>
          )}
        </div>
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={onSave} disabled={busy}>
              <CloudUpload className="h-4 w-4" aria-hidden="true" />
              {pending === "save" ? "Saving…" : "Save to server"}
            </Button>
            {remoteId && (
              <Button variant="outline" size="sm" onClick={() => setRefreshOpen(true)} disabled={busy}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                {pending === "refresh" ? "Refreshing…" : "Refresh from server"}
              </Button>
            )}
            {published ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setUnpublishOpen(true)}
                disabled={busy}
                className="border-danger/30 text-danger hover:bg-danger-soft hover:text-danger"
              >
                Unpublish
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={onPublish} disabled={busy}>
                {pending === "publish" ? "Publishing…" : "Publish to Community"}
              </Button>
            )}
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
          {new Date(publishedAt).toLocaleDateString()}. Save to server to send them.
        </p>
      )}
      {!readOnly && remoteId && !published && (
        <p role="status" className="text-xs text-muted-foreground">
          Saved on the server as a private copy. Publish to show it in Community.
        </p>
      )}

      <ConfirmDialog
        open={refreshOpen}
        onOpenChange={setRefreshOpen}
        title={`Refresh “${templateName}” from the server?`}
        description="The copy on the server replaces the one on this computer, including changes you have not saved."
        confirmLabel="Refresh template"
        busy={pending === "refresh"}
        onConfirm={async () => {
          onRefresh();
          setRefreshOpen(false);
        }}
      />

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