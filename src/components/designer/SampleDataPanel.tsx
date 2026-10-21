import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export interface Dataset {
  name: string;
  json: string;
  isDefault: boolean;
}

const QUICK_INSERT = [
  "store.name",
  "store.address",
  "order.id",
  "order.date",
  "order.customer",
  "order.items",
  "order.total",
  "order.subtotal",
  "order.tax",
  "barcode",
  "qr",
];

async function copyToken(token: string) {
  try {
    await navigator.clipboard.writeText(token);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = token;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
  toast.success(`Copied ${token}`);
}

interface Props {
  datasets: Dataset[];
  selectedName: string;
  onSelect: (name: string) => void;
  onAdd: () => void;
  onEdit: (dataset: Dataset) => void;
  onDelete: (dataset: Dataset) => void;
}

/**
 * The sample datasets the canvas is rendered with, and the field chips for the
 * chosen one. It controls what the canvas shows, so on desktop it is an
 * accordion section, and on a phone a tab.
 */
export function SampleDataPanel({
  datasets,
  selectedName,
  onSelect,
  onAdd,
  onEdit,
  onDelete,
}: Props) {
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={onAdd}
        >
          <Plus className="h-3 w-3" />
          Add Dataset
        </Button>
      </div>
      {datasets.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No datasets yet. Add one to preview and validate templates.
        </p>
      ) : (
        datasets.map((ds) => {
          let parsed: Record<string, unknown> | null;
          try {
            parsed = JSON.parse(ds.json);
          } catch {
            parsed = null;
          }
          const fields = parsed ? Object.keys(parsed) : [];
          return (
            <div key={ds.name} className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <input
                    type="radio"
                    name="dataset"
                    aria-label={`Use dataset ${ds.name}`}
                    checked={selectedName === ds.name}
                    onChange={() => onSelect(ds.name)}
                  />
                  <span className="truncate text-sm font-medium">
                    {ds.name}
                  </span>
                  {ds.isDefault && (
                    <Badge variant="secondary" className="text-xs">
                      Default
                    </Badge>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => onEdit(ds)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs"
                    aria-label={`Delete dataset ${ds.name}`}
                    onClick={() => onDelete(ds)}
                    disabled={ds.isDefault}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
              <div className="space-y-1 text-xs text-muted-foreground">
                <p>Fields:</p>
                <div className="flex flex-wrap gap-1">
                  {fields.map((f) => (
                    <button
                      key={f}
                      type="button"
                      className="cursor-pointer rounded-full border px-2 py-0.5 font-mono text-xs hover:bg-muted"
                      onClick={() => void copyToken(`{{${f}}}`)}
                      title="Copy to clipboard"
                    >
                      {"{{"}
                      {f}
                      {"}}"}
                    </button>
                  ))}
                </div>
              </div>
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  View JSON
                </summary>
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-xs">
                  {ds.json}
                </pre>
              </details>
            </div>
          );
        })
      )}

      <div className="space-y-2 border-t pt-3">
        <h3 className="text-xs font-semibold">Quick Insert</h3>
        <p className="text-xs text-muted-foreground">
          Click a variable chip below to copy it, then paste into the HTML/CSS.
        </p>
        <div className="flex flex-wrap gap-1">
          {QUICK_INSERT.map((v) => (
            <button
              key={v}
              type="button"
              className="cursor-pointer rounded-full border px-2 py-0.5 font-mono text-xs hover:bg-primary hover:text-primary-foreground"
              onClick={() => void copyToken(`{{${v}}}`)}
            >
              {"{{"}
              {v}
              {"}}"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
