import {
  Blocks,
  FileText,
  PanelLeftOpen,
  Ruler,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/** The accordion section ids, in the order the accordion lists them. */
export type ControlsSection = "templates" | "page" | "helpers" | "custom";

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
  const sections: {
    id: ControlsSection;
    labelKey: string;
    Icon: LucideIcon;
  }[] = [
    { id: "templates", labelKey: "designer.templates", Icon: FileText },
    { id: "page", labelKey: "designer.pageSetup", Icon: Ruler },
    { id: "helpers", labelKey: "designer.helpers", Icon: Wand2 },
    { id: "custom", labelKey: "designer.custom_input", Icon: Blocks },
  ];
  const button =
    "flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11";
  return (
    <nav
      aria-label={t("designer.controls_collapsed")}
      className="flex w-12 flex-col items-center gap-1 rounded-lg border bg-card py-2"
    >
      <button
        type="button"
        aria-label={t("designer.expand_controls")}
        title={t("designer.expand_controls")}
        onClick={onExpand}
        className={button}
      >
        <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
      </button>
      <div className="my-1 h-px w-6 bg-border" />
      {sections.map(({ id, labelKey, Icon }) => (
        <button
          key={id}
          type="button"
          aria-label={t("designer.open_section", {
            section: t(labelKey),
          })}
          title={t(labelKey)}
          onClick={() => onOpenSection(id)}
          className={cn(button)}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </button>
      ))}
    </nav>
  );
}
