import { useRef } from "react";
import { Check, QrCode, Save, Type } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { agent } from "@/lib/agent/commands";

interface Props {
  onBarcode: () => void;
  onSaveVersion: () => void;
  /** Phones only: the canvas is a tab there. On desktop it is always visible, so there is nothing to switch to. */
  onShowCanvas?: () => void;
  className?: string;
}

/** Barcode, Font and Save Version. Wraps on a phone so Save is never pushed off-screen. */
export function DesignerActions({ onBarcode, onSaveVersion, onShowCanvas, className }: Props) {
  const fontInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className={`flex flex-wrap items-center justify-between gap-2 ${className ?? ""}`}>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onBarcode}>
          <QrCode className="h-4 w-4" />
          Barcode
        </Button>
        <Button variant="outline" size="sm" onClick={() => fontInputRef.current?.click()} title="Upload font for this template">
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
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onSaveVersion} data-testid="designer-save-version">
          <Save className="h-4 w-4" />
          Save Version
        </Button>
        {onShowCanvas && (
          <Button size="sm" onClick={onShowCanvas}>
            <Check className="h-4 w-4" />
            Save & Preview
          </Button>
        )}
      </div>
    </div>
  );
}
