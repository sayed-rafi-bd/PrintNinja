import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";
import { Switch } from "@/components/ui/switch";

interface Props {
  templateName: string;
  remoteId: string | null;
  publishedAt: string | null;
  /** Saved (community) copies are read-only: actions are hidden. */
  readOnly?: boolean;
  /** The action running right now, so the switch disables while it runs. */
  pending: "save" | "visibility" | null;
  onVisibilityChange: (makePublic: boolean) => void;
}

/**
 * Where the local copy stands with the server. Publish is visibility-only:
 * a switch showing Public/Private that calls publish/unpublish immediately.
 */
export function TemplateSyncBar({
  templateName,
  remoteId,
  publishedAt,
  readOnly = false,
  pending,
  onVisibilityChange,
}: Props) {
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
        {!readOnly && remoteId && (
          <div className="flex items-center gap-2">
            <Label htmlFor="template-visibility" className="text-xs">
              {published ? "Public" : "Private"}
            </Label>
            <Switch
              id="template-visibility"
              data-testid="template-visibility"
              checked={published}
              disabled={busy}
              onCheckedChange={(v) => onVisibilityChange(v)}
              aria-label={`Template visibility: ${published ? "Public" : "Private"}`}
            />
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
          Private copy on the server. Flip the switch to show it in Community.
        </p>
      )}
      {!readOnly && published && (
        <p role="status" className="text-xs text-muted-foreground">
          Public — Save updates the live copy, no need to publish again.
        </p>
      )}
      {!readOnly && !remoteId && (
        <p role="status" className="sr-only">
          Template {templateName} is local only
        </p>
      )}
    </>
  );
}
