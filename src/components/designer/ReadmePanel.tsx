import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ReadmeEditor } from "@/components/ReadmeEditor";

interface Props {
  readme: string;
  onChange: (value: string) => void;
  templateName: string;
  saving: boolean;
  onSave: () => void;
}

/** The template's README: title, Save button, and the Markdown editor. */
export function ReadmePanel({
  readme,
  onChange,
  templateName,
  saving,
  onSave,
}: Props) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="min-w-0 truncate text-sm font-semibold">
          {t("readme.panel_title", { name: templateName })}
        </h2>
        <Button size="sm" onClick={onSave} disabled={saving}>
          {saving ? t("readme.saving") : t("readme.save")}
        </Button>
      </div>
      <ReadmeEditor
        value={readme}
        onChange={onChange}
        templateName={templateName}
      />
    </div>
  );
}
