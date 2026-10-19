import { useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";

interface Props {
  templateName: string;
  remoteId: string | null;
  publishedAt: string | null;
  templateUpdatedAt: string | null;
  publishing: boolean;
  onPublish: () => void;
  onUnpublish: () => void | Promise<void>;
}

/** Draft or Published state, the publish actions, and the unpublished-changes strip. */
export function PublishBar({ templateName, remoteId, publishedAt, templateUpdatedAt, publishing, onPublish, onUnpublish }: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const hasUnpublished =
    !!remoteId && !!publishedAt && !!templateUpdatedAt && new Date(templateUpdatedAt) > new Date(publishedAt);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2">
        <StatusBadge status={remoteId ? "published" : "draft"} />
        <div className="flex items-center gap-2">
          {remoteId ? (
            <>
              <Button size="sm" onClick={onPublish} disabled={publishing}>
                {publishing ? "Publishing…" : "Update published copy"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setConfirmOpen(true)} disabled={publishing} className="border-danger/30 text-danger hover:bg-danger-soft hover:text-danger">
                Unpublish
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={onPublish} disabled={publishing}>
              {publishing ? "Publishing…" : "Publish"}
            </Button>
          )}
        </div>
      </div>

      {hasUnpublished && publishedAt && (
        <div role="status" className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">
          You have changes that aren’t published. Other people still see the version from {new Date(publishedAt).toLocaleDateString()}.
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Unpublish “${templateName}”?`}
        description="It stays on this computer but disappears from Community."
        confirmLabel="Unpublish"
        destructive
        busy={publishing}
        onConfirm={async () => { await onUnpublish(); setConfirmOpen(false); }}
      />
    </>
  );
}
