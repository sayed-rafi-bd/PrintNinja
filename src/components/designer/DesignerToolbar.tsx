import { useRef } from "react";
import { Download, Plus, Save, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

interface Props {
  onNew: () => void;
  onSave: () => void;
  onImportFile: (file: File) => void | Promise<void>;
  onExport: () => void;
  /** Offline: the server owns the copies, so there is nowhere to save. */
  saveDisabled?: boolean;
  saveTitle?: string;
}

/** New, Save, Import, and Export for the template being edited. Save is
 * the one manual push to the server; offline it is disabled because
 * viewing and printing are all the cache can do. */
export function DesignerToolbar({
  onNew,
  onSave,
  onImportFile,
  onExport,
  saveDisabled = false,
  saveTitle,
}: Props) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant="outline" size="sm" onClick={onNew}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        {t("designer.newTemplate")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={onSave}
        disabled={saveDisabled}
        title={saveTitle}
        data-testid="designer-save"
      >
        <Save className="h-4 w-4" aria-hidden="true" />
        Save
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => fileInputRef.current?.click()}
      >
        <Upload className="h-4 w-4" aria-hidden="true" />
        Import
      </Button>
      <Button variant="outline" size="sm" onClick={onExport}>
        <Download className="h-4 w-4" aria-hidden="true" />
        Export
      </Button>
      <input
        type="file"
        accept="application/json,text/html"
        ref={fileInputRef}
        data-testid="template-import"
        aria-label="Import template file"
        tabIndex={-1}
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            await onImportFile(file);
          } finally {
            if (fileInputRef.current) fileInputRef.current.value = "";
          }
        }}
      />
    </>
  );
}
