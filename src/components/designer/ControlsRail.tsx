import { Clock, FileText, Database, PanelLeftOpen, Ruler, Wand2, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/** The accordion section ids, in the order the accordion lists them. */
export type ControlsSection = "templates" | "page" | "sample-data" | "versions" | "helpers";

interface Props {
  /** Open the controls column, with this section open. */
  onOpenSection: (section: ControlsSection) => void;
  /** Open the controls column as it was. */
  onExpand: () => void;
}

/**
 * The 48 px strip the controls column shrinks to on a narrow desktop window:
 * one icon per accordion section, so the editor and canvas get the room.
 */
export function ControlsRail({ onOpenSection, onExpand }: Props) {
  const { t } = useTranslation();
  const sections: { id: ControlsSection; label: string; Icon: LucideIcon }[] = [
    { id: "templates", label: "Templates", Icon: FileText },
    { id: "page", label: t("designer.pageSetup"), Icon: Ruler },
    { id: "sample-data", label: t("designer.sampleData"), Icon: Database },
    { id: "versions", label: t("designer.versions"), Icon: Clock },
    { id: "helpers", label: "Helpers", Icon: Wand2 },
  ];
  const button =
    "flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11";
  return (
    <nav aria-label="Designer controls (collapsed)" className="flex w-12 flex-col items-center gap-1 rounded-lg border bg-card py-2">
      <button type="button" aria-label="Expand controls" title="Expand controls" onClick={onExpand} className={button}>
        <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
      </button>
      <div className="my-1 h-px w-6 bg-border" />
      {sections.map(({ id, label, Icon }) => (
        <button key={id} type="button" aria-label={`Open ${label}`} title={label} onClick={() => onOpenSection(id)} className={cn(button)}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </button>
      ))}
    </nav>
  );
}
