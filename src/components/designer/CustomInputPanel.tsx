import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { QrCode, Type } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { agent } from "@/lib/agent/commands";

/** Barcode insert + font upload for the "Custom input" controls section. */
export function CustomInputPanel({ onBarcode }: { onBarcode: () => void }) {
  const { t } = useTranslation();
  const fontInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap gap-2 px-1 py-1">
      <Button variant="outline" size="sm" onClick={onBarcode}>
        <QrCode className="h-4 w-4" />
        {t("designer.custom_barcode")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => fontInputRef.current?.click()}
        title={t("designer.custom_font_title")}
      >
        <Type className="h-4 w-4" />
        {t("designer.custom_font")}
      </Button>
      <input
        ref={fontInputRef}
        aria-label={t("designer.custom_font_label")}
        tabIndex={-1}
        type="file"
        accept=".ttf,.otf,.woff,.woff2"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
            await agent("upload_font", {
              file_name: file.name,
              file_data: bytes,
              family: file.name.replace(/\.[^/.]+$/, ""),
            });
            toast.success(
              t("designer.custom_font_uploaded", { name: file.name }),
            );
          } catch (err) {
            toast.error(
              t("designer.custom_font_failed", { error: String(err) }),
            );
          } finally {
            if (fontInputRef.current) fontInputRef.current.value = "";
          }
        }}
      />
    </div>
  );
}
