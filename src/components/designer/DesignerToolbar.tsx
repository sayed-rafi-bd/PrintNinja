import { Plus, Save } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface Props {
  onNew: () => void;
  onSave: () => void;
  /** Offline: the server owns the copies, so there is nowhere to save. */
  saveDisabled?: boolean;
  saveTitle?: string;
  remoteId: string | null;
  publishedAt: string | null;
  /** Saved (community) copies are read-only: save and visibility are hidden. */
  readOnly?: boolean;
  /** The action running right now, so controls disable while it runs. */
  pending: "save" | "visibility" | null;
  onVisibilityChange: (makePublic: boolean) => void;
}

/** New, Save and visibility for the template being edited. Save is
 * the one manual push to the server; offline it is disabled because
 * viewing and printing are all the cache can do. Visibility is
 * publish/unpublish applied immediately via the switch, whose
 * Public/Private label already describes the state. */
export function DesignerToolbar({
  onNew,
  onSave,
  saveDisabled = false,
  saveTitle,
  remoteId,
  publishedAt,
  readOnly = false,
  pending,
  onVisibilityChange,
}: Props) {
  const { t } = useTranslation();
  const busy = pending != null;
  const published = !!remoteId && !!publishedAt;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onClick={onNew}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        {t("designer.newTemplate")}
      </Button>
      {!readOnly && (
        <Button
          variant="outline"
          size="sm"
          onClick={onSave}
          disabled={saveDisabled || busy}
          title={saveTitle}
          data-testid="designer-save"
        >
          <Save className="h-4 w-4" aria-hidden="true" />
          {t("common.save")}
        </Button>
      )}
      {readOnly ? (
        <span className="text-xs text-muted-foreground">
          {t("designer.read_only")}
        </span>
      ) : !remoteId ? (
        <span className="text-xs text-muted-foreground">
          {t("designer.only_local")}
        </span>
      ) : (
        <div className="flex items-center gap-2">
          <Label htmlFor="template-visibility" className="text-xs">
            {published
              ? t("designer.visibility_public")
              : t("designer.visibility_private")}
          </Label>
          <Switch
            id="template-visibility"
            data-testid="template-visibility"
            checked={published}
            disabled={busy}
            onCheckedChange={(v) => onVisibilityChange(v)}
            aria-label={t("designer.visibility_toggle", {
              state: published
                ? t("designer.visibility_public")
                : t("designer.visibility_private"),
            })}
          />
        </div>
      )}
    </div>
  );
}
