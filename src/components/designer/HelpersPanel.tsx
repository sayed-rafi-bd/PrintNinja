import { Badge } from "@/components/ui/badge";
import { BARCODE_TYPES } from "@/lib/utils/barcode";

const HELPERS = ["currency", "date", "upper", "lower", "padLeft", "number"];

/** The Handlebars helpers and barcode types a template can use. */
export function HelpersPanel() {
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">Available helpers:</div>
      <div className="flex flex-wrap gap-1">
        {HELPERS.map((helper) => (
          <Badge key={helper} variant="outline" className="font-mono text-xs">
            {`{{${helper}}}`}
          </Badge>
        ))}
      </div>
      <div className="text-xs text-muted-foreground">Barcode types:</div>
      <div className="flex flex-wrap gap-1">
        {BARCODE_TYPES.slice(0, 5).map((bc) => (
          <Badge key={bc.value} variant="outline" className="text-xs">
            {bc.label}
          </Badge>
        ))}
        <Badge variant="outline" className="text-xs">+{BARCODE_TYPES.length - 5} more</Badge>
      </div>
    </div>
  );
}
