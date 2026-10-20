import { FileText, GitCompare, Plus, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { TemplateVersion } from "@/lib/store/templateStore";
import { cn } from "@/lib/utils";

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
}

/**
 * Left column: template list, page setup, and version history.
 * Plain cards for now; Phase 2 of docs/DESIGNER_LAYOUT_PLAN.md turns them into
 * accordion sections.
 */
export function ControlsAccordion<T extends { id: number; name: string }>({
  templates, currentTemplateId, loadTemplate, templateName, setTemplateName,
  pageWidth, setPageWidth, pageHeight, setPageHeight, presets: PAGE_PRESETS,
  orientation, setOrientation, versions, onNewVersion, openDiff, handleRestoreVersion,
}: Props<T>) {
  const { t } = useTranslation();
  return (
        <div className="space-y-4">
  <Card>
    <CardHeader className="pb-2">
      <CardTitle>Templates</CardTitle>
    </CardHeader>
    <CardContent className="space-y-1">
      {templates.map((tpl) => {
        const active = tpl.id === currentTemplateId;
        return (
          <button
            key={tpl.id}
            type="button"
            onClick={() => loadTemplate(tpl)}
            aria-current={active ? "true" : undefined}
            className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors", active ? "bg-accent font-medium text-accent-foreground" : "hover:bg-muted")}
          >
            <FileText className="h-4 w-4 shrink-0" />
            <span className="truncate">{tpl.name}</span>
          </button>
        );
      })}
    </CardContent>
  </Card>

  <Card>
    <CardHeader className="pb-2">
      <CardTitle>{t("designer.pageSetup")}</CardTitle>
    </CardHeader>
    <CardContent className="space-y-3">
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
    </CardContent>
  </Card>

  {/* Versions Panel */}
  <Card>
    <CardHeader className="pb-2">
      <div className="flex items-center justify-between">
        <CardTitle>{t("designer.versions")}</CardTitle>
        <Button variant="ghost" size="sm" className="h-6" aria-label="Save version" title="Save version" onClick={onNewVersion}>
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </CardHeader>
    <CardContent className="space-y-1 max-h-48 overflow-y-auto">
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
              className={cn(
                "flex items-center justify-between p-2 rounded-md border",
                isCurrent && "bg-secondary",
              )}
            >
              <div className="min-w-0">
                <p className="text-xs font-medium">
                  v{v.version_no}
                  {isCurrent && (
                    <span className="ml-1 text-xs text-primary">
                      current
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {v.label || v.note || v.created_at.slice(0, 16)}
                </p>
              </div>
              <div className="flex gap-1 shrink-0">
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
    </CardContent>
  </Card>
</div>
  );
}
