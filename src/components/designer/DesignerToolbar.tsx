import { useRef } from "react";
import { Download, Plus, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

interface Props {
  onNew: () => void;
  onImportFile: (file: File) => void | Promise<void>;
  onExport: () => void;
}

/** New, Import, and Export for the template being edited. */
export function DesignerToolbar({ onNew, onImportFile, onExport }: Props) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant="outline" size="sm" onClick={onNew}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        {t("designer.newTemplate")}
      </Button>
      <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
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
