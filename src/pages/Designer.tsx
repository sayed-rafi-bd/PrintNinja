import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Plus,
  FileText,
  Download,
  Upload,
  RotateCcw,
  Trash2,
  ZoomIn,
  ZoomOut,
  Save,
  GitCompare,
  Type,
  QrCode,
  Check,
} from "lucide-react";
import { useTemplateStore, type Template, type TemplateVersion } from "@/lib/store/templateStore";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import CodeMirror from "@uiw/react-codemirror";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { BARCODE_TYPES, validateBarcode, buildBarcodeHtml } from "@/lib/utils/barcode";
import { DEFAULT_TEMPLATE_HTML, DEFAULT_TEMPLATE_CSS, DEFAULT_MOCK_DATA, STARTER_TEMPLATES } from "@/lib/templates/defaultTemplate";
import { VisualDesigner } from "@/components/VisualDesigner";
import { renderTemplate } from "@/lib/render/renderTemplate";

const PAGE_PRESETS = [
  { label: "A4", width: 210, height: 297 },
  { label: "A5", width: 148, height: 210 },
  { label: "Letter", width: 216, height: 279 },
  { label: "80mm Roll", width: 80, height: 200 },
  { label: "58mm Roll", width: 58, height: 200 },
  { label: "4x6 Label", width: 102, height:152 },
];

const MM_TO_PX = 3.7795;

export function DesignerPage() {
  const { t } = useTranslation();
  const store = useTemplateStore();
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [showVersionDialog, setShowVersionDialog] = useState(false);
  const [versionLabel, setVersionLabel] = useState("");
  const [versionNote, setVersionNote] = useState("");
  const [showBarcodeDialog, setShowBarcodeDialog] = useState(false);
  const [barcodeType, setBarcodeType] = useState("code128");
  const [barcodeValue, setBarcodeValue] = useState("");
  const [barcodeError, setBarcodeError] = useState<string | null>(null);
  const [showNewTemplateDialog, setShowNewTemplateDialog] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [htmlCode, setHtmlCode] = useState(DEFAULT_TEMPLATE_HTML);
  const [cssCode, setCssCode] = useState(DEFAULT_TEMPLATE_CSS);
  const [templateName, setTemplateName] = useState(STARTER_TEMPLATES[0].name);
  const [pageWidth, setPageWidth] = useState(STARTER_TEMPLATES[0]?.page_w_mm ?? 80);
  const [pageHeight, setPageHeight] = useState(STARTER_TEMPLATES[0]?.page_h_mm ?? 200);
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("portrait");
  const [zoom, setZoom] = useState(1);
  const [activeTab, setActiveTab] = useState("canvas");
  const [debouncedHtml, setDebouncedHtml] = useState(htmlCode);
  const [debouncedCss, setDebouncedCss] = useState(cssCode);
  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedHtml(htmlCode);
      setDebouncedCss(cssCode);
    }, 300);
    return () => clearTimeout(id);
  }, [htmlCode, cssCode]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Templates available in the designer — persisted in SQLite via
  // `list_templates` / `create_template`. Starter templates are the
  // fallback when the DB is empty (first launch) or in web mode.
  const [templates, setTemplates] = useState<Array<{ id: number; name: string; html: string; css: string; page_w_mm?: number; page_h_mm?: number; orientation?: string }>>([]);
  const [currentTemplateId, setCurrentTemplateId] = useState<number | null>(null);
  const [_templatesLoading, setTemplatesLoading] = useState(true);
  void _templatesLoading;

  // Sample datasets (variables)
  const [datasets, setDatasets] = useState<Array<{ name: string; json: string; isDefault: boolean }>>([
    {
      name: "Sample Order",
      json: JSON.stringify(DEFAULT_MOCK_DATA, null, 2),
      isDefault: true,
    },
  ]);

  const loadTemplate = (tpl: { id: number; name: string; html: string; css: string; page_w_mm?: number; page_h_mm?: number; orientation?: string }) => {
    setCurrentTemplateId(tpl.id);
    setTemplateName(tpl.name);
    setHtmlCode(tpl.html);
    setCssCode(tpl.css);
    if (tpl.page_w_mm) setPageWidth(tpl.page_w_mm);
    if (tpl.page_h_mm) setPageHeight(tpl.page_h_mm);
    if (tpl.orientation) setOrientation(tpl.orientation as "portrait" | "landscape");
    setCurrentTemplateDbId(tpl.id);
    setDiff(null);
    setShowDiff(false);
    // Load the persisted versions for the newly selected template.
    (async () => {
      try {
        const list = await invoke<TemplateVersion[]>("list_versions", {
          templateId: tpl.id,
        });
        setVersions(list ?? []);
      } catch {
        setVersions([]);
      }
    })();
    toast.success(`Loaded "${tpl.name}"`);
  };

  const createNewTemplate = async () => {
    const name = newTemplateName.trim();
    if (!name) {
      toast.error("Template name required");
      return;
    }
    if (templates.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      toast.error("Template already exists");
      return;
    }
    try {
      const created = await invoke<{ id: number; name: string; page_w_mm: number; page_h_mm: number; orientation: string }>("create_template", {
        req: {
          name,
          page_w_mm: STARTER_TEMPLATES[0].page_w_mm,
          page_h_mm: STARTER_TEMPLATES[0].page_h_mm,
          orientation: STARTER_TEMPLATES[0].orientation,
          html: DEFAULT_TEMPLATE_HTML,
          css: DEFAULT_TEMPLATE_CSS,
        },
      });
      const tpl = {
        id: created.id,
        name: created.name,
        html: DEFAULT_TEMPLATE_HTML,
        css: DEFAULT_TEMPLATE_CSS,
        page_w_mm: created.page_w_mm,
        page_h_mm: created.page_h_mm,
        orientation: created.orientation,
      };
      setTemplates((prev) => [...prev, tpl]);
      loadTemplate(tpl);
      setVersions([]);
      setCurrentTemplateDbId(tpl.id);
      toast.success(`Template "${name}" created`);
    } catch {
      // Web mode / DB unavailable — keep in-memory fallback so UI stays usable.
      const id = templates.length ? Math.max(...templates.map((t) => t.id)) + 1 : 1;
      const tpl = {
        id,
        name,
        html: DEFAULT_TEMPLATE_HTML,
        css: DEFAULT_TEMPLATE_CSS,
        page_w_mm: STARTER_TEMPLATES[0].page_w_mm,
        page_h_mm: STARTER_TEMPLATES[0].page_h_mm,
        orientation: STARTER_TEMPLATES[0].orientation,
      };
      setTemplates((prev) => [...prev, tpl]);
      loadTemplate(tpl);
      setVersions([]);
      setCurrentTemplateDbId(tpl.id);
      toast.success(`Template "${name}" created locally`);
    } finally {
      setNewTemplateName("");
      setShowNewTemplateDialog(false);
    }
  };
  const [selectedDatasetName, setSelectedDatasetName] = useState("Sample Order");
  const [showDatasetDialog, setShowDatasetDialog] = useState(false);
  const [datasetName, setDatasetName] = useState("");
  const [datasetJson, setDatasetJson] = useState("{\n  \n}");
  const [editingDataset, setEditingDataset] = useState<string | null>(null);
  const [editJson, setEditJson] = useState("");
  const [showEditDataset, setShowEditDataset] = useState(false);

  // The active template's DB row id (created on first save / on load).
  const [currentTemplateDbId, setCurrentTemplateDbId] = useState(1);
  const [diff, setDiff] = useState<{
    from_version_no: number;
    to_version_no: number;
    html_from: string;
    html_to: string;
    css_from: string;
    css_to: string;
    html_changed: boolean;
    css_changed: boolean;
  } | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  const canvasRef = useRef<HTMLDivElement>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);

  // Load template list from SQLite on mount; fall back to starters in web
  // mode or on first launch when the table is empty.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await invoke<Array<{ id: number; name: string; page_w_mm: number; page_h_mm: number; orientation: string; current_version_id?: number | null }>>("list_templates");
        if (cancelled) return;
        if (rows && rows.length > 0) {
          // For each persisted template, fetch its current version to get html/css.
          const hydrated = await Promise.all(
            rows.map(async (r) => {
              try {
                const versions = await invoke<TemplateVersion[]>("list_versions", { templateId: r.id });
                const latest = versions?.[0];
                return {
                  id: r.id,
                  name: r.name,
                  html: latest?.html ?? DEFAULT_TEMPLATE_HTML,
                  css: latest?.css ?? DEFAULT_TEMPLATE_CSS,
                  page_w_mm: r.page_w_mm,
                  page_h_mm: r.page_h_mm,
                  orientation: r.orientation,
                };
              } catch {
                return {
                  id: r.id,
                  name: r.name,
                  html: DEFAULT_TEMPLATE_HTML,
                  css: DEFAULT_TEMPLATE_CSS,
                  page_w_mm: r.page_w_mm,
                  page_h_mm: r.page_h_mm,
                  orientation: r.orientation,
                };
              }
            }),
          );
          setTemplates(hydrated);
          setCurrentTemplateId(hydrated[0].id);
          setTemplateName(hydrated[0].name);
          setHtmlCode(hydrated[0].html);
          setCssCode(hydrated[0].css);
          setPageWidth(hydrated[0].page_w_mm ?? 80);
          setPageHeight(hydrated[0].page_h_mm ?? 200);
          setOrientation((hydrated[0].orientation as "portrait" | "landscape") ?? "portrait");
          setCurrentTemplateDbId(hydrated[0].id);
        } else {
          const starters = STARTER_TEMPLATES.map((t, i) => ({
            id: i + 1,
            name: t.name,
            html: t.html,
            css: t.css,
            page_w_mm: t.page_w_mm,
            page_h_mm: t.page_h_mm,
            orientation: t.orientation,
          }));
          setTemplates(starters);
          setCurrentTemplateId(starters[0].id);
        }
      } catch {
        const starters = STARTER_TEMPLATES.map((t, i) => ({
          id: i + 1,
          name: t.name,
          html: t.html,
          css: t.css,
          page_w_mm: t.page_w_mm,
          page_h_mm: t.page_h_mm,
          orientation: t.orientation,
        }));
        setTemplates(starters);
        setCurrentTemplateId(starters[0].id);
      } finally {
        if (!cancelled) setTemplatesLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Load persisted versions for the active template.
    if (currentTemplateDbId != null) refreshVersions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTemplateDbId]);

  useEffect(() => {
    const template: Template = {
      id: 1,
      name: templateName,
      current_version_id: null,
      page_w_mm: pageWidth,
      page_h_mm: pageHeight,
      orientation,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    store.setCurrentTemplate(template);
  }, []);

  const handleSaveVersion = async () => {
    try {
      const version = await invoke<TemplateVersion>("create_version", {
        req: {
          template_id: currentTemplateDbId,
          html: htmlCode,
          css: cssCode,
          label: versionLabel || null,
          note: versionNote || null,
          created_by: "manual",
        },
      });
      setVersions((prev) => [version, ...prev]);
      setShowVersionDialog(false);
      setVersionLabel("");
      setVersionNote("");
      toast.success(`Version ${version.version_no} saved`);
    } catch (e) {
      // Web mode / no backend: keep a local snapshot so the UI stays usable.
      const local: TemplateVersion = {
        id: Date.now(),
        template_id: currentTemplateDbId,
        version_no: versions.length + 1,
        html: htmlCode,
        css: cssCode,
        label: versionLabel || null,
        note: versionNote || null,
        created_at: new Date().toISOString(),
        created_by: "manual",
      };
      setVersions((prev) => [local, ...prev]);
      setShowVersionDialog(false);
      setVersionLabel("");
      setVersionNote("");
      toast.success(`Version ${local.version_no} saved locally`);
    }
  };

  const handleInsertBarcode = () => {
    const error = validateBarcode(barcodeType, barcodeValue);
    if (error) {
      setBarcodeError(error);
      return;
    }
    // Inline SVG (not a data URI): the printed HTML must not depend on an
    // external image, and SVG stays crisp at any printer DPI.
    const html = buildBarcodeHtml({
      type: barcodeType,
      value: barcodeValue,
      scaleToWidth: 40,
    });
    if (html) {
      setHtmlCode((prev) => prev + "\n" + html);
      setShowBarcodeDialog(false);
      setBarcodeValue("");
      setBarcodeError(null);
      toast.success(`${barcodeType} barcode inserted`);
    } else {
      setBarcodeError("Could not generate this barcode");
    }
  };

  const refreshVersions = async () => {
    try {
      const list = await invoke<TemplateVersion[]>("list_versions", {
        templateId: currentTemplateDbId,
      });
      setVersions(list ?? []);
      const latest = list?.[0];
      if (latest) {
        setHtmlCode(latest.html);
        setCssCode(latest.css);
      }
    } catch {
      // Backend not available (web mode) — keep the in-editor content.
    }
  };

  const handleRestoreVersion = async (version: TemplateVersion) => {
    try {
      // Restore creates a NEW version server-side; nothing is overwritten.
      const created = await invoke<TemplateVersion>("restore_version", {
        id: version.id,
      });
      setVersions((prev) => [created, ...prev]);
      setHtmlCode(created.html);
      setCssCode(created.css);
      toast.success(`Restored v${version.version_no} as v${created.version_no}`);
    } catch {
      setHtmlCode(version.html);
      setCssCode(version.css);
      toast.success(`Restored version ${version.version_no}`);
    }
  };

  const openDiff = async (from: TemplateVersion, to: TemplateVersion) => {
    try {
      const d = await invoke<{
        from_version_no: number;
        to_version_no: number;
        html_from: string;
        html_to: string;
        css_from: string;
        css_to: string;
        html_changed: boolean;
        css_changed: boolean;
      }>("diff_versions", { fromId: from.id, toId: to.id });
      setDiff(d);
    } catch {
      setDiff({
        from_version_no: from.version_no,
        to_version_no: to.version_no,
        html_from: from.html,
        html_to: to.html,
        css_from: from.css,
        css_to: to.css,
        html_changed: from.html !== to.html,
        css_changed: from.css !== to.css,
      });
    }
  };

  const canvasWidth = pageWidth * MM_TO_PX * zoom;
  const canvasHeight = pageHeight * MM_TO_PX * zoom;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("designer.title")}</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowNewTemplateDialog(true)}>
            <Plus className="h-4 w-4" />
            {t("designer.newTemplate")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-4 w-4" />
            Import
          </Button>
          <Button variant="outline" size="sm" onClick={() => {
            const data = { name: templateName, html: htmlCode, css: cssCode };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${templateName.replace(/\s+/g, "-")}.json`;
            a.click();
            URL.revokeObjectURL(url);
            toast.success("Template exported");
          }}>
            <Download className="h-4 w-4" />
            Export
          </Button>
        </div>
        <input
          type="file"
          accept="application/json,text/html"
          ref={fileInputRef}
          data-testid="template-import"
          aria-hidden="true"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              const text = await file.text();
              const isHtml = file.name.toLowerCase().endsWith(".html") || text.trim().toLowerCase().startsWith("<!doctype") || text.trim().toLowerCase().startsWith("<html");
              if (isHtml) {
                setTemplateName(file.name.replace(/\.html$/i, ""));
                setHtmlCode(text);
                toast.success("HTML template imported");
              } else {
                const data = JSON.parse(text);
                setTemplateName(data.name || file.name.replace(/\.(json|html)$/, ""));
                if (data.html) setHtmlCode(data.html);
                if (data.css) setCssCode(data.css);
                toast.success("Template imported");
              }
            } catch {
              toast.error("Invalid template file");
            } finally {
              if (fileInputRef.current) fileInputRef.current.value = "";
            }
          }}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Left Panel - Template List & Page Setup */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Templates</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {templates.map((tpl) => {
                const active = tpl.id === currentTemplateId;
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => loadTemplate(tpl)}
                    className={`flex w-full items-center gap-2 rounded-md p-2 text-left text-sm transition-colors ${active ? "bg-secondary font-medium" : "hover:bg-muted"}`}
                  >
                    <FileText className="h-4 w-4 shrink-0" />
                    <span className="truncate">{tpl.name}</span>
                    {active && (
                      <span className="ml-auto rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                        Active
                      </span>
                    )}
                  </button>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{t("designer.pageSetup")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">{t("designer.template_name")}</Label>
                <Input value={templateName} onChange={(e) => setTemplateName(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Width (mm)</Label>
                  <Input type="number" value={pageWidth} onChange={(e) => setPageWidth(Number(e.target.value))} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Height (mm)</Label>
                  <Input type="number" value={pageHeight} onChange={(e) => setPageHeight(Number(e.target.value))} />
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
                <Label className="text-xs">{t("designer.orientation")}</Label>
                <Select value={orientation} onValueChange={(v) => setOrientation(v as "portrait" | "landscape")}>
                  <SelectTrigger>
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
                <CardTitle className="text-sm">{t("designer.versions")}</CardTitle>
                <Button variant="ghost" size="sm" className="h-6" onClick={() => setShowVersionDialog(true)}>
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
                            <span className="ml-1 text-[10px] text-primary">
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

        {/* Main Canvas + Code */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full max-w-[420px] overflow-x-auto">
              <TabsList className="grid w-full grid-cols-5">
                <TabsTrigger value="canvas" className="text-xs">{t("designer.canvas")}</TabsTrigger>
                <TabsTrigger value="visual" className="text-xs">Visual</TabsTrigger>
                <TabsTrigger value="code" className="text-xs">{t("designer.code")}</TabsTrigger>
                <TabsTrigger value="preview" className="text-xs">{t("designer.preview")}</TabsTrigger>
                <TabsTrigger value="variables" className="text-xs">{t("designer.variables")}</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}>
                <ZoomOut className="h-4 w-4" />
              </Button>
              <span className="text-xs w-12 text-center">{Math.round(zoom * 100)}%</span>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setZoom((z) => Math.min(3, z + 0.25))}>
                <ZoomIn className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {activeTab === "canvas" && (
            <Card>
              <CardContent className="p-0">
                <div className="flex items-center justify-center min-h-[500px] bg-gray-100 dark:bg-gray-900 rounded-b-lg overflow-auto">
                  <div
                    ref={canvasRef}
                    className="bg-white shadow-lg border border-gray-200 relative"
                    style={{ width: canvasWidth, height: canvasHeight, transformOrigin: "top left" }}
                  >
                    <iframe
                      srcDoc={renderTemplate(
                        debouncedHtml,
                        debouncedCss,
                        (() => {
                          try {
                            const ds = datasets.find((d) => d.name === selectedDatasetName) ?? datasets[0];
                            return JSON.parse(ds.json);
                          } catch {
                            return DEFAULT_MOCK_DATA;
                          }
                        })(),
                      )}
                      className="pointer-events-none"
                      title="Canvas preview"
                      style={{ width: "100%", height: "100%", border: 0 }}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === "visual" && (
            <VisualDesigner
              initialHtml={htmlCode}
              initialCss={cssCode}
              onHtmlChange={setHtmlCode}
              onCssChange={setCssCode}
            />
          )}

          {activeTab === "code" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">HTML</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <CodeMirror
                    value={htmlCode}
                    height="500px"
                    extensions={[html()]}
                    onChange={setHtmlCode}
                    theme="dark"
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">CSS</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <CodeMirror
                    value={cssCode}
                    height="500px"
                    extensions={[css()]}
                    onChange={setCssCode}
                    theme="dark"
                  />
                </CardContent>
              </Card>
            </div>
          )}

          {activeTab === "preview" && (
            <Card>
              <CardContent className="p-0">
                <div className="flex items-center justify-center min-h-[500px] bg-gray-100 dark:bg-gray-900 rounded-b-lg">
                  <div className="bg-white shadow-lg border overflow-auto" style={{ width: pageWidth * MM_TO_PX, minHeight: pageHeight * MM_TO_PX }}>
                    <iframe
                      srcDoc={renderTemplate(htmlCode, cssCode, DEFAULT_MOCK_DATA as any)}
                      className="w-full border-0"
                      style={{ height: pageHeight * MM_TO_PX, width: "100%" }}
                      title="Preview"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === "variables" && (
            <div className="space-y-4">
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">{t("designer.variables")}</CardTitle>
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => {
                      setDatasetName("");
                      setDatasetJson("{\n  \n}");
                      setShowDatasetDialog(true);
                    }}>
                      <Plus className="h-3 w-3" />
                      Add Dataset
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {datasets.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No datasets yet. Add one to preview and validate templates.</p>
                  ) : (
                    datasets.map((ds) => {
                      let parsed: any;
                      try { parsed = JSON.parse(ds.json); } catch { parsed = null; }
                      const fields = parsed ? Object.keys(parsed) : [];
                      return (
                        <div key={ds.name} className="border rounded-md p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <input
                                type="radio"
                                name="dataset"
                                checked={selectedDatasetName === ds.name}
                                onChange={() => setSelectedDatasetName(ds.name)}
                              />
                              <span className="text-sm font-medium">{ds.name}</span>
                              {ds.isDefault && <Badge variant="secondary" className="text-[10px]">Default</Badge>}
                            </div>
                            <div className="flex gap-1">
                              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => {
                                setEditingDataset(ds.name);
                                setEditJson(ds.json);
                                setShowEditDataset(true);
                              }}>
                                Edit
                              </Button>
                              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => {
                                setDatasets((prev) => prev.filter((d) => d.name !== ds.name));
                                if (selectedDatasetName === ds.name) {
                                  setSelectedDatasetName(datasets[0]?.name ?? "");
                                }
                                toast.success("Dataset deleted");
                              }} disabled={ds.isDefault}>
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          </div>
                          <div className="text-xs text-muted-foreground space-y-1">
                            <p>Fields:</p>
                            <div className="flex flex-wrap gap-1">
                              {fields.map((f) => (
                                <button
                                  key={f}
                                  type="button"
                                  className="rounded-full border px-2 py-0.5 font-mono text-[10px] hover:bg-muted cursor-pointer"
                                  onClick={async () => {
                                    const token = `{{${f}}}`;
                                    try { await navigator.clipboard.writeText(token); toast.success(`Copied ${token}`); }
                                    catch { const ta=document.createElement("textarea");ta.value=token;document.body.appendChild(ta);ta.select();document.execCommand("copy");document.body.removeChild(ta);toast.success(`Copied ${token}`); }
                                  }}
                                  title="Copy to clipboard"
                                >
                                  {"{{"}{f}{"}}"}
                                </button>
                              ))}
                            </div>
                          </div>
                          <details className="text-xs">
                            <summary className="cursor-pointer text-muted-foreground">View JSON</summary>
                            <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-[10px]">{ds.json}</pre>
                          </details>
                        </div>
                      );
                    })
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Quick Insert</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground mb-2">
                    Click a variable chip below to copy it, then paste into the HTML/CSS.
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {["store.name", "store.address", "order.id", "order.date", "order.customer", "order.items", "order.total", "order.subtotal", "order.tax", "barcode", "qr"].map((v) => (
                      <button
                        key={v}
                        type="button"
                        className="rounded-full border px-2 py-0.5 font-mono text-[10px] hover:bg-primary hover:text-primary-foreground cursor-pointer"
                        onClick={async () => {
                          const token = `{{${v}}}`;
                          try { await navigator.clipboard.writeText(token); toast.success(`Copied ${token}`); }
                          catch { const ta=document.createElement("textarea");ta.value=token;document.body.appendChild(ta);ta.select();document.execCommand("copy");document.body.removeChild(ta);toast.success(`Copied ${token}`); }
                        }}
                      >
                        {"{{"}{v}{"}}"}
                      </button>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Action Bar */}
          <div className="flex items-center justify-between">
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowBarcodeDialog(true)}>
                <QrCode className="h-4 w-4" />
                Barcode
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fontInputRef.current?.click()}
                title="Upload font for this template"
              >
                <Type className="h-4 w-4" />
                Font
              </Button>
              <input
                ref={fontInputRef}
                type="file"
                accept=".ttf,.otf,.woff,.woff2"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
                    await invoke("upload_font", {
                      fileName: file.name,
                      fileData: bytes,
                      family: file.name.replace(/\.[^/.]+$/, ""),
                    });
                    toast.success(`Font "${file.name}" uploaded`);
                  } catch (err) {
                    toast.error(`Font upload failed: ${err}`);
                  } finally {
                    if (fontInputRef.current) fontInputRef.current.value = "";
                  }
                }}
              />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowVersionDialog(true)}>
                <Save className="h-4 w-4" />
                Save Version
              </Button>
              <Button size="sm" onClick={() => {
                setActiveTab("preview");
                toast.success("Preview updated — see Preview tab");
              }}>
                <Check className="h-4 w-4" />
                Save & Preview
              </Button>
            </div>
          </div>
        </div>

        {/* Right Panel - Properties */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Properties</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">Page</Label>
                <div className="text-sm">{pageWidth} x {pageHeight} mm</div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Orientation</Label>
                <div className="text-sm">{orientation}</div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Zoom</Label>
                <div className="text-sm">{Math.round(zoom * 100)}%</div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Quick Helpers</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="text-xs text-muted-foreground">
                Available helpers:
              </div>
              <div className="flex flex-wrap gap-1">
                {["currency", "date", "upper", "lower", "padLeft", "number"].map((helper) => (
                  <Badge key={helper} variant="outline" className="text-xs font-mono">
                    {`{{${helper}}}`}
                  </Badge>
                ))}
              </div>
              <div className="text-xs text-muted-foreground">
                Barcode types:
              </div>
              <div className="flex flex-wrap gap-1">
                {BARCODE_TYPES.slice(0, 5).map((bc) => (
                  <Badge key={bc.value} variant="outline" className="text-xs">
                    {bc.label}
                  </Badge>
                ))}
                <Badge variant="outline" className="text-xs">+{BARCODE_TYPES.length - 5} more</Badge>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Diff Dialog */}
      <Dialog open={showDiff} onOpenChange={setShowDiff}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              Compare v{diff?.from_version_no} → v{diff?.to_version_no}
            </DialogTitle>
          </DialogHeader>
          {diff && (
            <div className="space-y-4 max-h-[70vh] overflow-auto">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant={diff.html_changed ? "warning" : "secondary"}>
                    {diff.html_changed ? "HTML changed" : "HTML identical"}
                  </Badge>
                  <Badge variant={diff.css_changed ? "warning" : "secondary"}>
                    {diff.css_changed ? "CSS changed" : "CSS identical"}
                  </Badge>
                </div>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <div>
                  <p className="text-xs font-semibold mb-1">
                    v{diff.from_version_no} (before)
                  </p>
                  <pre className="text-[10px] bg-muted p-2 rounded overflow-auto max-h-72 whitespace-pre-wrap">
                    {diff.html_from || "(empty)"}
                  </pre>
                </div>
                <div>
                  <p className="text-xs font-semibold mb-1">
                    v{diff.to_version_no} (after)
                  </p>
                  <pre className="text-[10px] bg-muted p-2 rounded overflow-auto max-h-72 whitespace-pre-wrap">
                    {diff.html_to || "(empty)"}
                  </pre>
                </div>
              </div>
              {(diff.html_changed || diff.css_changed) && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs font-semibold mb-1">
                      CSS v{diff.from_version_no}
                    </p>
                    <pre className="text-[10px] bg-muted p-2 rounded overflow-auto max-h-48 whitespace-pre-wrap">
                      {diff.css_from || "(empty)"}
                    </pre>
                  </div>
                  <div>
                    <p className="text-xs font-semibold mb-1">
                      CSS v{diff.to_version_no}
                    </p>
                    <pre className="text-[10px] bg-muted p-2 rounded overflow-auto max-h-48 whitespace-pre-wrap">
                      {diff.css_to || "(empty)"}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDiff(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Save Version Dialog */}
      <Dialog open={showVersionDialog} onOpenChange={setShowVersionDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save Version</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Label</Label>
              <Input placeholder="e.g. Added logo" value={versionLabel} onChange={(e) => setVersionLabel(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Note</Label>
              <Input placeholder="Optional note" value={versionNote} onChange={(e) => setVersionNote(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowVersionDialog(false)}>Cancel</Button>
            <Button onClick={handleSaveVersion}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Barcode Dialog */}
      <Dialog open={showBarcodeDialog} onOpenChange={setShowBarcodeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Insert Barcode</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="barcode-type">Type</Label>
              <Select value={barcodeType} onValueChange={setBarcodeType}>
                <SelectTrigger id="barcode-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BARCODE_TYPES.map((bc) => (
                    <SelectItem key={bc.value} value={bc.value}>{bc.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="barcode-value">Value</Label>
              <Input id="barcode-value" placeholder="Enter barcode value" value={barcodeValue} onChange={(e) => { setBarcodeValue(e.target.value); setBarcodeError(null); }} />
              {barcodeError && (
                <p id="barcode-error" role="alert" className="text-xs text-red-500">{barcodeError}</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBarcodeDialog(false)}>Cancel</Button>
            <Button id="barcode-insert" onClick={handleInsertBarcode} disabled={!barcodeValue}>
              <QrCode className="h-4 w-4" />
              Insert
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Dataset Dialog */}
      <Dialog open={showDatasetDialog} onOpenChange={setShowDatasetDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Dataset</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input value={datasetName} onChange={(e) => setDatasetName(e.target.value)} placeholder="e.g. Empty Order" />
            </div>
            <div className="space-y-1">
              <Label>JSON data</Label>
              <div className="rounded-md border overflow-hidden">
                <CodeMirror
                  value={datasetJson}
                  height="160px"
                  extensions={[html()]}
                  onChange={setDatasetJson}
                  theme="dark"
                  basicSetup={{ lintKeymap: true }}
                />
              </div>
              {(() => { try { JSON.parse(datasetJson); return null; } catch (e) { return <p className="text-xs text-red-500">{String(e).split("\n")[0]}</p>; }})()}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDatasetDialog(false)}>Cancel</Button>
            <Button onClick={() => {
              if (!datasetName.trim()) {
                toast.error("Dataset name required");
                return;
              }
              try {
                JSON.parse(datasetJson);
              } catch {
                toast.error("Invalid JSON");
                return;
              }
              setDatasets((prev) => [...prev, { name: datasetName, json: datasetJson, isDefault: false }]);
              setShowDatasetDialog(false);
              toast.success(`Dataset "${datasetName}" added`);
            }}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dataset Dialog */}
      <Dialog open={showEditDataset} onOpenChange={setShowEditDataset}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Dataset: {editingDataset}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md border overflow-hidden">
              <CodeMirror
                value={editJson}
                height="200px"
                extensions={[html()]}
                onChange={setEditJson}
                theme="dark"
              />
            </div>
            {(() => { try { JSON.parse(editJson); return null; } catch (e) { return <p className="text-xs text-red-500">{String(e).split("\n")[0]}</p>; }})()}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditDataset(false)}>Cancel</Button>
            <Button onClick={() => {
              try {
                JSON.parse(editJson);
              } catch {
                toast.error("Invalid JSON");
                return;
              }
              setDatasets((prev) => prev.map((d) => d.name === editingDataset ? { ...d, json: editJson } : d));
              setShowEditDataset(false);
              toast.success("Dataset updated");
            }}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Template Dialog */}
      <Dialog open={showNewTemplateDialog} onOpenChange={setShowNewTemplateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Template</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Template Name</Label>
              <Input placeholder="My Template" value={newTemplateName} onChange={(e) => setNewTemplateName(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewTemplateDialog(false)}>Cancel</Button>
            <Button onClick={createNewTemplate}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
