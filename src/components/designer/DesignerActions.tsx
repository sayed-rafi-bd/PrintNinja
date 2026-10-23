import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  /** Phones only: the canvas is a tab there. On desktop it is always visible, so there is nothing to switch to. */
  onShowCanvas?: () => void;
  className?: string;
}

/** Save & Preview, phones only. Barcode and font live in the "Custom input"
 * controls section now. Wraps so the button is never pushed off-screen. */
export function DesignerActions({ onShowCanvas, className }: Props) {
  if (!onShowCanvas) return null;
  return (
    <div
      className={`flex flex-wrap items-center justify-end gap-2 ${className ?? ""}`}
    >
      <Button size="sm" onClick={onShowCanvas}>
        <Check className="h-4 w-4" />
        Save & Preview
      </Button>
    </div>
  );
}
