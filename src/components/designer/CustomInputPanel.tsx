import { useRef } from "react";
import { QrCode, Type } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { agent } from "@/lib/agent/commands";

/** Barcode insert + font upload for the "Custom input" controls section. */
export function CustomInputPanel({ onBarcode }: { onBarcode: () => void }) {
  const fontInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap gap-2 px-1 py-1">
      <Button variant="outline" size="sm" onClick={onBarcode}>
        <QrCode className="h-4 w-4" />
        Barcode
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => fontInputRef.current?.click()}
        title="Upload font for this template"
      >
        <Type className="h-4 w-4" />
        Font
      </Button>
      <input
        ref={fontInputRef}
        aria-label="Upload font file"
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
            toast.success(`Font "${file.name}" uploaded`);
          } catch (err) {
            toast.error(`Font upload failed: ${err}`);
          } finally {
            if (fontInputRef.current) fontInputRef.current.value = "";
          }
        }}
      />
    </div>
  );
}
