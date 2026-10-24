import { useTranslation } from "react-i18next";
import { Columns2, PanelTop, Rows2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type DesignerLayout = "side" | "stacked" | "canvas";

export const DESIGNER_LAYOUTS: readonly DesignerLayout[] = [
  "side",
  "stacked",
  "canvas",
];

export function isDesignerLayout(value: unknown): value is DesignerLayout {
  return (
    typeof value === "string" &&
    (DESIGNER_LAYOUTS as readonly string[]).includes(value)
  );
}

const OPTIONS: {
  value: DesignerLayout;
  labelKey: string;
  Icon: typeof Columns2;
}[] = [
  { value: "side", labelKey: "designer.layout_side", Icon: Columns2 },
  { value: "stacked", labelKey: "designer.layout_stacked", Icon: Rows2 },
  { value: "canvas", labelKey: "designer.layout_canvas", Icon: PanelTop },
];

interface Props {
  value: DesignerLayout;
  onChange: (value: DesignerLayout) => void;
}

/** Side by side, stacked (editor above canvas), or canvas only. Desktop only. */
export function LayoutToggle({ value, onChange }: Props) {
  const { t } = useTranslation();
  return (
    <div
      role="group"
      aria-label={t("designer.layout_label")}
      className="inline-flex rounded-md border bg-background p-0.5"
    >
      {OPTIONS.map(({ value: v, labelKey, Icon }) => (
        <button
          key={v}
          type="button"
          aria-label={t(labelKey)}
          aria-pressed={value === v}
          title={t(labelKey)}
          onClick={() => onChange(v)}
          className={cn(
            "flex h-7 w-8 items-center justify-center rounded-sm text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === v ? "bg-accent text-accent-foreground" : "hover:bg-muted",
          )}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
