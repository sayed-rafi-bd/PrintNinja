import type { ReactNode } from "react";
import { FileText, GitCompare, Plus, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { TemplateVersion } from "@/lib/store/templateStore";
import { cn } from "@/lib/utils";
import { HelpersPanel } from "./HelpersPanel";

export interface PagePreset { label: string; width: number; height: number }

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
  versions: TemplateVersion[];
  onNewVersion: () => void;
  openDiff: (from: TemplateVersion, to: TemplateVersion) => void;
  handleRestoreVersion: (v: TemplateVersion) => void;
  /** The Sample data section's content. Omitted on a phone, where Sample data is a tab. */
  sampleData?: ReactNode;
  /** Show the Helpers section. A phone shows the helpers inside the Sample data tab instead. */
  showHelpers?: boolean;
  /** Section ids open at first: "templates", "page", "sample-data", "versions", "helpers". Desktop opens only "page"; a phone opens none. */
  defaultOpen?: string[];
  /** Controlled open sections. When given, the parent owns (and can remember) which are open. */
  openSections?: string[];
  onOpenSectionsChange?: (sections: string[]) => void;
  /** Click-to-insert for the Helpers section; without it the helpers are only a reference. */
  onInsertHelper?: (text: string) => void;
}

/**
 * The controls column: template list, page setup, sample data, version history
 * and helpers, as accordion sections. Several can be open at once.
 */
export function ControlsAccordion<T extends { id: number; name: string }>({
  templates, currentTemplateId, loadTemplate, templateName, setTemplateName,
  pageWidth, setPageWidth, pageHeight, setPageHeight, presets: PAGE_PRESETS,
  orientation, setOrientation, versions, onNewVersion, openDiff, handleRestoreVersion,
  sampleData, showHelpers = true, defaultOpen = ["page"],
  openSections, onOpenSectionsChange, onInsertHelper,
}: Props<T>) {
  const { t } = useTranslation();
  const open = openSections
    ? { value: openSections, onValueChange: onOpenSectionsChange }
    : { defaultValue: defaultOpen };
  return (
    <Accordion type="multiple" {...open} className="rounded-lg border bg-card px-3">
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
                className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors [@media(pointer:coarse)]:min-h-11", active ? "bg-accent font-medium text-accent-foreground" : "hover:bg-muted")}
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
            <Label htmlFor="designer-template-name" className="text-xs">{t("designer.template_name")}</Label>
            <Input id="designer-template-name" value={templateName} onChange={(e) => setTemplateName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="designer-width" className="text-xs">Width (mm)</Label>
              <Input id="designer-width" type="number" value={pageWidth} onChange={(e) => setPageWidth(Number(e.target.value))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="designer-height" className="text-xs">Height (mm)</Label>
              <Input id="designer-height" type="number" value={pageHeight} onChange={(e) => setPageHeight(Number(e.target.value))} />
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
            <Label htmlFor="designer-orientation" className="text-xs">{t("designer.orientation")}</Label>
            <Select value={orientation} onValueChange={(v) => setOrientation(v as "portrait" | "landscape")}>
              <SelectTrigger id="designer-orientation" aria-label="Orientation">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="portrait">{t("designer.portrait")}</SelectItem>
                <SelectItem value="landscape">{t("designer.landscape")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </AccordionContent>
      </AccordionItem>

      {sampleData && (
        <AccordionItem value="sample-data">
          <AccordionTrigger>{t("designer.sampleData")}</AccordionTrigger>
          <AccordionContent>{sampleData}</AccordionContent>
        </AccordionItem>
      )}

      <AccordionItem value="versions">
        <AccordionTrigger>{t("designer.versions")}</AccordionTrigger>
        <AccordionContent className="space-y-2">
          <Button variant="outline" size="sm" className="h-7 text-xs" aria-label="Save version" onClick={onNewVersion}>
            <Plus className="h-3 w-3" />
            Save version
          </Button>
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {versions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No versions yet — use “Save Version” to snapshot.
              </p>
            ) : (
              versions.map((v, i) => {
                const isCurrent = i === 0;
                const older = versions[i + 1];
                return (
                  <div
                    key={v.id}
                    className={cn("flex items-center justify-between rounded-md border p-2", isCurrent && "bg-secondary")}
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-medium">
                        v{v.version_no}
                        {isCurrent && <span className="ml-1 text-xs text-primary">current</span>}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {v.label || v.note || v.created_at.slice(0, 16)}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {older && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0"
                          title={`Diff v${older.version_no} → v${v.version_no}`}
                          aria-label={`Diff v${older.version_no} to v${v.version_no}`}
                          onClick={() => openDiff(older, v)}
                        >
                          <GitCompare className="h-3 w-3" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        title="Restore this version"
                        aria-label={`Restore version ${v.version_no}`}
                        disabled={isCurrent}
                        onClick={() => handleRestoreVersion(v)}
                      >
                        <RotateCcw className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
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
    </Accordion>
  );
}
