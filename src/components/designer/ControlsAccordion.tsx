import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { cn } from "@/lib/utils";
import { HelpersPanel } from "./HelpersPanel";
import { CustomInputPanel } from "./CustomInputPanel";

export interface PagePreset {
  label: string;
  width: number;
  height: number;
}

interface Props<T extends { id: number; name: string }> {
  templates: T[];
  currentTemplateId: number | null;
  loadTemplate: (tpl: T) => void;
  templateName: string;
  setTemplateName: (v: string) => void;
  pageWidth: number;
  setPageWidth: (v: number) => void;
  pageHeight: number;
  setPageHeight: (v: number) => void;
  presets: PagePreset[];
  orientation: "portrait" | "landscape";
  setOrientation: (v: "portrait" | "landscape") => void;
  /** Show the Helpers section. A phone shows the helpers inside the Sample data tab instead. */
  showHelpers?: boolean;
  /** Open the barcode dialog. Renders the "Custom input" section (barcode + font). */
  onBarcode?: () => void;
  /** Section ids open at first: "templates", "page", "helpers", "custom". Desktop opens only "page"; a phone opens none. */
  defaultOpen?: string[];
  /** Controlled open sections. When given, the parent owns (and can remember) which are open. */
  openSections?: string[];
  onOpenSectionsChange?: (sections: string[]) => void;
  /** Click-to-insert for the Helpers section; without it the helpers are only a reference. */
  onInsertHelper?: (text: string) => void;
}

/**
 * The controls column: template list, page setup, helpers
 * and custom input, as accordion sections. Several can be open at once.
 * (Sample data lives in the editor pane, after the HTML / CSS / README tabs.)
 */
export function ControlsAccordion<T extends { id: number; name: string }>({
  templates,
  currentTemplateId,
  loadTemplate,
  templateName,
  setTemplateName,
  pageWidth,
  setPageWidth,
  pageHeight,
  setPageHeight,
  presets: PAGE_PRESETS,
  orientation,
  setOrientation,
  showHelpers = true,
  defaultOpen = ["page"],
  openSections,
  onOpenSectionsChange,
  onInsertHelper,
  onBarcode,
}: Props<T>) {
  const { t } = useTranslation();
  const open = openSections
    ? { value: openSections, onValueChange: onOpenSectionsChange }
    : { defaultValue: defaultOpen };
  return (
    <Accordion
      type="multiple"
      {...open}
      className="rounded-lg border bg-card px-3"
    >
      <AccordionItem value="templates">
        <AccordionTrigger>Templates</AccordionTrigger>
        <AccordionContent className="space-y-1">
          {templates.map((tpl) => {
            const active = tpl.id === currentTemplateId;
            return (
              <button
                key={tpl.id}
                type="button"
                onClick={() => loadTemplate(tpl)}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors [@media(pointer:coarse)]:min-h-11",
                  active
                    ? "bg-accent font-medium text-accent-foreground"
                    : "hover:bg-muted",
                )}
              >
                <FileText className="h-4 w-4 shrink-0" />
                <span className="truncate">{tpl.name}</span>
              </button>
            );
          })}
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="page">
        <AccordionTrigger>{t("designer.pageSetup")}</AccordionTrigger>
        <AccordionContent className="space-y-3 px-1">
          <div className="space-y-1">
            <Label htmlFor="designer-template-name" className="text-xs">
              {t("designer.template_name")}
            </Label>
            <Input
              id="designer-template-name"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="designer-width" className="text-xs">
                Width (mm)
              </Label>
              <Input
                id="designer-width"
                type="number"
                value={pageWidth}
                onChange={(e) => setPageWidth(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="designer-height" className="text-xs">
                Height (mm)
              </Label>
              <Input
                id="designer-height"
                type="number"
                value={pageHeight}
                onChange={(e) => setPageHeight(Number(e.target.value))}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Presets</Label>
            <div className="flex flex-wrap gap-1">
              {PAGE_PRESETS.map((preset) => (
                <Button
                  key={preset.label}
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    setPageWidth(preset.width);
                    setPageHeight(preset.height);
                  }}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="designer-orientation" className="text-xs">
              {t("designer.orientation")}
            </Label>
            <Select
              value={orientation}
              onValueChange={(v) =>
                setOrientation(v as "portrait" | "landscape")
              }
            >
              <SelectTrigger id="designer-orientation" aria-label="Orientation">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="portrait">
                  {t("designer.portrait")}
                </SelectItem>
                <SelectItem value="landscape">
                  {t("designer.landscape")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </AccordionContent>
      </AccordionItem>

      {showHelpers && (
        <AccordionItem value="helpers">
          <AccordionTrigger>Helpers</AccordionTrigger>
          <AccordionContent>
            <HelpersPanel onInsert={onInsertHelper} />
          </AccordionContent>
        </AccordionItem>
      )}

      {onBarcode && (
        <AccordionItem value="custom">
          <AccordionTrigger>Custom input</AccordionTrigger>
          <AccordionContent>
            <CustomInputPanel onBarcode={onBarcode} />
          </AccordionContent>
        </AccordionItem>
      )}
    </Accordion>
  );
}
