import { Badge } from "@/components/ui/badge";
import { BARCODE_TYPES } from "@/lib/utils/barcode";

export const HELPERS = [
  "currency",
  "date",
  "upper",
  "lower",
  "padLeft",
  "number",
  "barcode",
  "qrcode",
];

/** What clicking a helper inserts: `{{currency }}`, with the cursor placed before the closing braces. */
export function helperSnippet(helper: string): { text: string; back: number } {
  // A barcode needs its symbology first, so start the call with one.
  if (helper === "barcode") return { text: `{{barcode "code128" }}`, back: 2 };
  return { text: `{{${helper} }}`, back: 2 };
}

interface Props {
  /** Insert text at the editor's cursor. Without it the helpers are a plain list. */
  onInsert?: (text: string, back?: number) => void;
}

/** The Handlebars helpers and barcode types a template can use. */
export function HelpersPanel({ onInsert }: Props) {
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">
        {onInsert
          ? "Click a helper to insert it at the cursor:"
          : "Available helpers:"}
      </div>
      <div className="flex flex-wrap gap-1">
        {HELPERS.map((helper) =>
          onInsert ? (
            <button
              key={helper}
              type="button"
              aria-label={`Insert ${helper} helper`}
              title={`Insert {{${helper} }} at the cursor`}
              onClick={() => {
                const { text, back } = helperSnippet(helper);
                onInsert(text, back);
              }}
              className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Badge
                variant="outline"
                className="cursor-pointer font-mono text-xs hover:bg-muted"
              >
                {`{{${helper}}}`}
              </Badge>
            </button>
          ) : (
            <Badge key={helper} variant="outline" className="font-mono text-xs">
              {`{{${helper}}}`}
            </Badge>
          ),
        )}
      </div>
      <div className="text-xs text-muted-foreground">Barcode types:</div>
      <div className="flex flex-wrap gap-1">
        {BARCODE_TYPES.slice(0, 5).map((bc) => (
          <Badge key={bc.value} variant="outline" className="text-xs">
            {bc.label}
          </Badge>
        ))}
        <Badge variant="outline" className="text-xs">
          +{BARCODE_TYPES.length - 5} more
        </Badge>
      </div>
    </div>
  );
}
