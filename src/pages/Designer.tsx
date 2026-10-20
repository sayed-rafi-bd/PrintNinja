import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/PageHeader";
import { ControlsAccordion, type VersionRow } from "@/components/designer/ControlsAccordion";
import { CanvasWorkspace } from "@/components/designer/CanvasWorkspace";
import { CodeEditors, EditorPane, type EditorPaneHandle } from "@/components/designer/EditorPane";
import { ControlsRail, type ControlsSection } from "@/components/designer/ControlsRail";
import { LayoutToggle, isDesignerLayout, type DesignerLayout } from "@/components/designer/LayoutToggle";
import { DesignerActions } from "@/components/designer/DesignerActions";
import { DesignerToolbar } from "@/components/designer/DesignerToolbar";
import { HelpersPanel } from "@/components/designer/HelpersPanel";
import { ReadmePanel } from "@/components/designer/ReadmePanel";
import { SampleDataPanel, type Dataset } from "@/components/designer/SampleDataPanel";
import { TemplateSyncBar } from "@/components/designer/TemplateSyncBar";
import { ClassWarnings } from "@/components/designer/ClassWarnings";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { DESKTOP_QUERY, WIDE_QUERY, useMediaQuery } from "@/lib/hooks/useMediaQuery";
import { usePersistentState } from "@/lib/hooks/usePersistentState";
import { useEffect, useMemo, useRef, useState } from "react";
import { agent } from "@/lib/agent/commands";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { PanelLeftClose, QrCode } from "lucide-react";
import { useTemplateStore, type Template, type TemplateVersion } from "@/lib/store/templateStore";
import { toast } from "sonner";
import CodeMirror from "@uiw/react-codemirror";
import { html } from "@codemirror/lang-html";
import { BARCODE_TYPES, validateBarcode, buildBarcodeHtml } from "@/lib/utils/barcode";
import { DEFAULT_TEMPLATE_HTML, DEFAULT_TEMPLATE_CSS, DEFAULT_MOCK_DATA, STARTER_TEMPLATES } from "@/lib/templates/defaultTemplate";
import { compiledFields } from "@/lib/templates/compileTemplateCss";
import { useCompiledCss } from "@/lib/templates/useCompiledCss";
import { formatCss, formatHtml } from "@/lib/utils/format";
import { ensureStarterTemplates } from "@/lib/templates/seedTemplates";
import * as share from "@/lib/share/client";
import { notifyLocalEdit, syncNow } from "@/lib/sync/useSyncStatus";
import {
  getLocalTemplate,
  isReadOnly,
  saveToServer,
  type SaveOptions,
} from "@/lib/share/sync";
import type { TemplateRow } from "@/lib/agent/types";

const PAGE_PRESETS = [
  { label: "A4", width: 210, height: 297 },
  { label: "A5", width: 148, height: 210 },
  { label: "Letter", width: 216, height: 279 },
  { label: "80mm Roll", width: 80, height: 200 },
  { label: "58mm Roll", width: 58, height: 200 },
  { label: "4x6 Label", width: 102, height:152 },
];

/** Which sync action is running, so only its button says so. */
type SyncAction = "save" | "publish" | "unpublish" | "sync";

export function DesignerPage() {
  const { t } = useTranslation();
  const store = useTemplateStore();
  const [versions, setVersions] = useState<VersionRow[]>([]);
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
  // Which tab is open on a phone. On desktop the canvas and editor are always both on screen.
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  // Desktop workspace preferences, remembered across launches.
  const [layout, setLayout] = usePersistentState<DesignerLayout>("printninja.designer.layout", "side", isDesignerLayout);
  const [openSections, setOpenSections] = usePersistentState<string[]>(
    "printninja.designer.openSections",
    ["page"],
    (v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string"),
  );
  // Below ~1440 px the controls column shrinks to an icon rail. Crossing that
  // width in either direction resets it; the person can still toggle it by hand.
  const isWide = useMediaQuery(WIDE_QUERY);
  const [controlsExpanded, setControlsExpanded] = useState(isWide);
  useEffect(() => setControlsExpanded(isWide), [isWide]);
  const editorRef = useRef<EditorPaneHandle>(null);
  const pendingInsert = useRef<{ text: string; back: number } | null>(null);
  useEffect(() => {
    const pending = pendingInsert.current;
    if (pending && editorRef.current) {
      pendingInsert.current = null;
      editorRef.current.insertAtCursor(pending.text, pending.back);
    }
  }, [layout]);
  const openControlsSection = (section: ControlsSection) => {
    setOpenSections(openSections.includes(section) ? openSections : [...openSections, section]);
    setControlsExpanded(true);
  };
  const [activeTab, setActiveTab] = useState("canvas");
  const [readme, setReadme] = useState("");
  const [readmeSaving, setReadmeSaving] = useState(false);
  const [remoteId, setRemoteId] = useState<string | null>(null);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [templateUpdatedAt, setTemplateUpdatedAt] = useState<string | null>(null);
  const [origin, setOrigin] = useState<"own" | "saved">("own");
  const [pending, setPending] = useState<SyncAction | null>(null);
  const [debouncedHtml, setDebouncedHtml] = useState(htmlCode);
  const [debouncedCss, setDebouncedCss] = useState(cssCode);
  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedHtml(htmlCode);
      setDebouncedCss(cssCode);
    }, 300);
    return () => clearTimeout(id);
  }, [htmlCode, cssCode]);
  const compiledCss = useCompiledCss(debouncedHtml);


  // Templates available in the designer — persisted in SQLite via
  // `list_templates` / `create_template`. Starter templates are the
  // fallback when the DB is empty (first launch) or in web mode.
  // Local working copies: content for the editor plus the server link
  // when the row came from a full template (nulls when it did not).
  const [templates, setTemplates] = useState<
    Array<{
      id: number;
      name: string;
      html: string;
      css: string;
      page_w_mm?: number;
      page_h_mm?: number;
      orientation?: string;
      readme?: string;
      summary?: string;
      remote_id?: string | null;
      server_id?: string | null;
      published_at?: string | null;
      origin?: string;
    }>
  >([]);
  const [currentTemplateId, setCurrentTemplateId] = useState<number | null>(null);
  const [_templatesLoading, setTemplatesLoading] = useState(true);
  void _templatesLoading;

  // Sample datasets (variables)
  const [datasets, setDatasets] = useState<Dataset[]>([
    {
      name: "Sample Order",
      json: JSON.stringify(DEFAULT_MOCK_DATA, null, 2),
      isDefault: true,
    },
  ]);

  const loadTemplate = (tpl: {
    id: number;
    name: string;
    html: string;
    css: string;
    page_w_mm?: number;
    page_h_mm?: number;
    orientation?: string;
    readme?: string;
    summary?: string;
    remote_id?: string | null;
    server_id?: string | null;
    published_at?: string | null;
    origin?: string;
    updated_at?: string;
  }) => {
    setCurrentTemplateId(tpl.id);
    setTemplateName(tpl.name);
    setHtmlCode(formatHtml(tpl.html));
    setCssCode(formatCss(tpl.css));
    if (tpl.page_w_mm) setPageWidth(tpl.page_w_mm);
    if (tpl.page_h_mm) setPageHeight(tpl.page_h_mm);
    if (tpl.orientation) setOrientation(tpl.orientation as "portrait" | "landscape");
    setCurrentTemplateDbId(tpl.id);
    setDiff(null);
    setShowDiff(false);
    // Load readme and publish info if provided, otherwise fetch from DB
    if (tpl.readme !== undefined) {
      setReadme(tpl.readme);
      setRemoteId(tpl.server_id ?? tpl.remote_id ?? null);
      setPublishedAt(tpl.published_at ?? null);
      setTemplateUpdatedAt(tpl.updated_at ?? null);
      setOrigin((tpl.origin ?? "own") === "saved" ? "saved" : "own");
    } else {
      (async () => {
        try {
          const full = await agent("get_template", { id: tpl.id });
          setReadme(full.readme ?? "");
          setRemoteId(full.server_id ?? full.remote_id ?? null);
          setPublishedAt(full.published_at ?? null);
          setTemplateUpdatedAt(full.updated_at ?? null);
          setOrigin(full.origin === "saved" ? "saved" : "own");
        } catch {
          setReadme("");
          setRemoteId(null);
          setPublishedAt(null);
          setTemplateUpdatedAt(null);
          setOrigin("own");
        }
      })();
    }
    // Load the persisted versions for the newly selected template.
    (async () => {
      try {
        const list = await agent("list_versions", {
          template_id: tpl.id,
        });
        setVersions(
          (list ?? []).map((v) => ({
            key: `local-${v.id}`,
            versionNo: v.version_no,
            label: v.label,
            note: v.note,
            createdAt: v.created_at,
            createdBy: v.created_by,
            html: v.html,
            css: v.css,
            localId: v.id,
          })),
        );
      } catch {
        setVersions([]);
      }
    })();
    toast.success(`Loaded "${tpl.name}"`);
  };

  /**
   * Write the editor into the local cache (a new version plus the
   * metadata) and tell the engine to push. Saving is local-first: the
   * server copy arrives through the next sync, not through a direct PUT.
   */
  const saveLocal = async (): Promise<TemplateRow | null> => {
    if (!currentTemplateDbId) {
      toast.error("No template selected");
      return null;
    }
    setPending("save");
    try {
      const row = await getLocalTemplate(currentTemplateDbId);
      if (isReadOnly(row)) {
        toast.error("A saved copy from Community can’t be changed");
        return null;
      }
      // The editor holds the copy this PC would print. Put its content and its
      // metadata into the local row first, so Print and this PC read the same copy.
      await agent("create_version", {
        req: {
          template_id: currentTemplateDbId,
          html: htmlCode,
          css: cssCode,
          ...(await compiledFields(htmlCode)),
          label: null,
          note: null,
          created_by: "manual",
        },
      });
      const updated = await agent("update_template_meta", {
        req: {
          id: currentTemplateDbId,
          name: templateName,
          page_w_mm: pageWidth,
          page_h_mm: pageHeight,
          summary: row.summary ?? "",
        },
      });
      setRemoteId((updated as { server_id?: string | null }).server_id ?? row.server_id ?? null);
      notifyLocalEdit();
      return { ...row, name: templateName, page_w_mm: pageWidth, page_h_mm: pageHeight };
    } finally {
      setPending(null);
    }
  };

  const handleSave = async () => {
    const saved = await saveLocal();
    if (saved) toast.success("Saved on this PC");
  };

  const runPublish = async (options: SaveOptions, done: string) => {
    if (!currentTemplateDbId) {
      toast.error("No template selected");
      return;
    }
    setPending("publish");
    try {
      const saved = await saveLocal();
      if (!saved) return;
      setPending("publish");
      const result = await saveToServer(saved, options);
      setRemoteId(result.remoteId);
      setPublishedAt(result.published ? result.updatedAt : null);
      setTemplateUpdatedAt(result.updatedAt);
      toast.success(done);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  const handlePublish = () => runPublish({ publish: true }, "Published to Community");

  const handleSyncNow = async () => {
    setPending("sync");
    try {
      await syncNow();
    } finally {
      setPending(null);
    }
  };


  const handleUnpublish = async () => {
    if (!currentTemplateDbId || !remoteId) return;
    setPending("unpublish");
    try {
      await share.unpublishTemplate(remoteId);
      await agent("clear_publish_info", { req: { id: currentTemplateDbId } });
      setRemoteId(null);
      setPublishedAt(null);
      toast.success("Unpublished");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text();
      const isHtml = file.name.toLowerCase().endsWith(".html") || text.trim().toLowerCase().startsWith("<!doctype") || text.trim().toLowerCase().startsWith("<html");
      if (isHtml) {
        setTemplateName(file.name.replace(/\.html$/i, ""));
        setHtmlCode(formatHtml(text));
        toast.success("HTML template imported");
      } else {
        const data = JSON.parse(text);
        setTemplateName(data.name || file.name.replace(/\.(json|html)$/, ""));
        if (data.html) setHtmlCode(formatHtml(data.html));
        if (data.css) setCssCode(formatCss(data.css));
        toast.success("Template imported");
      }
    } catch {
      toast.error("Invalid template file");
    }
  };

  const handleExport = () => {
    const data = { name: templateName, html: htmlCode, css: cssCode };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${templateName.replace(/\s+/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Template exported");
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
      const created = await agent("create_template", {
        req: {
          name,
          page_w_mm: STARTER_TEMPLATES[0].page_w_mm,
          page_h_mm: STARTER_TEMPLATES[0].page_h_mm,
          orientation: STARTER_TEMPLATES[0].orientation,
          html: DEFAULT_TEMPLATE_HTML,
          css: DEFAULT_TEMPLATE_CSS,
          ...(await compiledFields(DEFAULT_TEMPLATE_HTML)),
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
      notifyLocalEdit();
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

  // Load template list from SQLite on mount; fall back to starters in web
  // mode or on first launch when the table is empty.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Seeds the bundled starters into SQLite on first run, so the Designer
        // and the Print tab both see real rows instead of an empty list.
        const rows = await ensureStarterTemplates();
        if (cancelled) return;
        if (rows && rows.length > 0) {
          // For each persisted template, fetch its current version to get html/css.
          const hydrated = await Promise.all(
            rows.map(async (r) => {
              try {
                const versions = await agent("list_versions", { template_id: r.id });
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
          setHtmlCode(formatHtml(hydrated[0].html));
          setCssCode(formatCss(hydrated[0].css));
          setPageWidth(hydrated[0].page_w_mm ?? 80);
          setPageHeight(hydrated[0].page_h_mm ?? 200);
          setOrientation((hydrated[0].orientation as "portrait" | "landscape") ?? "portrait");
          setCurrentTemplateDbId(hydrated[0].id);
          // Load README and publish info for the first template
          try {
            const full = await agent("get_template", { id: hydrated[0].id });
            setReadme(full.readme ?? "");
            setRemoteId(full.server_id ?? full.remote_id ?? null);
            setPublishedAt(full.published_at ?? null);
            setTemplateUpdatedAt(full.updated_at ?? null);
            setOrigin(full.origin === "saved" ? "saved" : "own");
          } catch {
            setReadme("");
            setRemoteId(null);
            setPublishedAt(null);
            setTemplateUpdatedAt(null);
          }
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
    // Load persisted versions for the active template. Keyed on the
    // remote id too: it arrives after the row loads, and flips the
    // panel from local rows to the server list.
    if (currentTemplateDbId != null) refreshVersions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTemplateDbId, remoteId]);

  useEffect(() => {
    const template: Template = {
      id: 1,
      name: templateName,
      current_version_id: null,
      page_w_mm: pageWidth,
      page_h_mm: pageHeight,
      orientation,
      readme: "",
      summary: "",
      remote_id: null,
      server_id: null,
      published_at: null,
      origin: "own",
      origin_owner: null,
      withdrawn: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    store.setCurrentTemplate(template);
  }, []);

  /**
   * A labelled version goes through the server when the template is
   * pushed (the PUT records the label alongside the content); the local
   * row is written first so the panel updates at once, offline or not.
   */
  const handleSaveVersion = async () => {
    try {
      const version = await agent("create_version", {
        req: {
          template_id: currentTemplateDbId,
          html: htmlCode,
          css: cssCode,
          ...(await compiledFields(htmlCode)),
          label: versionLabel || null,
          note: versionNote || null,
          created_by: "manual",
        },
      });
      setShowVersionDialog(false);
      setVersionLabel("");
      setVersionNote("");
      if (remoteId) {
        try {
          const row = await getLocalTemplate(currentTemplateDbId);
          const saved = await saveToServer(
            { ...row, name: templateName, page_w_mm: pageWidth, page_h_mm: pageHeight },
            { version: { label: version.label, note: version.note } },
          );
          setRemoteId(saved.remoteId);
          setPublishedAt(saved.published ? saved.updatedAt : null);
          setTemplateUpdatedAt(saved.updatedAt);
        } catch (e) {
          toast.error(e instanceof Error ? e.message : String(e));
        }
      } else {
        notifyLocalEdit();
      }
      await refreshVersions();
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
      setVersions((prev) => [
        {
          key: `local-${local.id}`,
          versionNo: local.version_no,
          label: local.label,
          note: local.note,
          createdAt: local.created_at,
          createdBy: local.created_by,
          html: local.html,
          css: local.css,
          localId: local.id,
        },
        ...prev,
      ]);
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

  /**
   * The version history, newest first. A pushed template reads the
   * server list (the source of truth both PCs share); anything else
   * reads the local rows. Server rows fetch bodies on demand.
   */
  const refreshVersions = async () => {
    if (!currentTemplateDbId) {
      setVersions([]);
      return;
    }
    try {
      if (remoteId) {
        const list = await share.listRemoteVersions(remoteId);
        setVersions(
          list.map((v) => ({
            key: `srv-${v.version_no}`,
            versionNo: v.version_no,
            label: v.label,
            note: v.note,
            createdAt: v.created_at,
            createdBy: v.created_by,
            remoteNo: v.version_no,
          })),
        );
        return;
      }
      const list = await agent("list_versions", {
        template_id: currentTemplateDbId,
      });
      setVersions(
        (list ?? []).map((v) => ({
          key: `local-${v.id}`,
          versionNo: v.version_no,
          label: v.label,
          note: v.note,
          createdAt: v.created_at,
          createdBy: v.created_by,
          html: v.html,
          css: v.css,
          localId: v.id,
        })),
      );
      const latest = list?.[0];
      if (latest) {
        setHtmlCode(formatHtml(latest.html));
        setCssCode(formatCss(latest.css));
      }
    } catch {
      // Backend not available (web mode) — keep the in-editor content.
    }
  };

  const handleRestoreVersion = async (version: VersionRow) => {
    if (version.remoteNo != null && remoteId) {
      // Server restore copies the version into a new revision; the
      // current revision guards against overwriting a newer edit.
      try {
        const current = await share.fetchRemoteTemplate(remoteId);
        const restored = await share.restoreRemoteVersion(remoteId, version.remoteNo, current.revision);
        await refreshVersions();
        setHtmlCode(formatHtml(restored.body ?? ""));
        setCssCode(formatCss(restored.css ?? ""));
        setTemplateUpdatedAt(restored.updated_at);
        toast.success(`Restored v${version.versionNo} as v${restored.revision}`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (version.localId == null) return;
    try {
      // Restore creates a NEW version server-side; nothing is overwritten.
      const created = await agent("restore_version", {
        id: version.localId,
      });
      await refreshVersions();
      setHtmlCode(formatHtml(created.html));
      setCssCode(formatCss(created.css));
      toast.success(`Restored v${version.versionNo} as v${created.version_no}`);
    } catch {
      if (version.html !== undefined) setHtmlCode(formatHtml(version.html));
      if (version.css !== undefined) setCssCode(formatCss(version.css));
      toast.success(`Restored version ${version.versionNo}`);
    }
  };

  const handleDeleteVersion = async (version: VersionRow) => {
    if (version.remoteNo != null && remoteId) {
      try {
        await share.deleteRemoteVersion(remoteId, version.remoteNo);
        await refreshVersions();
        toast.success(`Deleted v${version.versionNo}`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (version.localId == null) return;
    try {
      await agent("delete_version", { id: version.localId });
      await refreshVersions();
      toast.success(`Deleted v${version.versionNo}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const openDiff = async (from: VersionRow, to: VersionRow) => {
    // Server rows fetch bodies on demand; local rows already carry them.
    const bodies = async (v: VersionRow): Promise<{ html: string; css: string }> => {
      if (v.html !== undefined) return { html: v.html ?? "", css: v.css ?? "" };
      if (v.remoteNo != null && remoteId) {
        const full = await share.readRemoteVersion(remoteId, v.remoteNo);
        return { html: full.body ?? "", css: full.css ?? "" };
      }
      return { html: "", css: "" };
    };
    try {
      const [f, t] = await Promise.all([bodies(from), bodies(to)]);
      if (from.localId != null && to.localId != null) {
        const d = await agent("diff_versions", { from_id: from.localId, to_id: to.localId });
        setDiff(d);
        return;
      }
      setDiff({
        from_version_no: from.versionNo,
        to_version_no: to.versionNo,
        html_from: f.html,
        html_to: t.html,
        css_from: f.css,
        css_to: t.css,
        html_changed: f.html !== t.html,
        css_changed: f.css !== t.css,
      });
    } catch {
      const [f, t] = await Promise.all([bodies(from).catch(() => ({ html: "", css: "" })), bodies(to).catch(() => ({ html: "", css: "" }))]);
      setDiff({
        from_version_no: from.versionNo,
        to_version_no: to.versionNo,
        html_from: f.html,
        html_to: t.html,
        css_from: f.css,
        css_to: t.css,
        html_changed: f.html !== t.html,
        css_changed: f.css !== t.css,
      });
    }
  };

  const sampleData = useMemo<Record<string, unknown>>(() => {
    try {
      const ds = datasets.find((d) => d.name === selectedDatasetName) ?? datasets[0];
      return JSON.parse(ds.json);
    } catch {
      return DEFAULT_MOCK_DATA as Record<string, unknown>;
    }
  }, [datasets, selectedDatasetName]);

  const handleSaveReadme = async () => {
    if (!currentTemplateDbId) {
      toast.error("No template selected");
      return;
    }
    const bytes = new TextEncoder().encode(readme).length;
    if (bytes > 64 * 1024) {
      toast.error("README exceeds 64 KiB");
      return;
    }
    setReadmeSaving(true);
    try {
      await agent("update_readme", { req: { id: currentTemplateDbId, readme } });
      notifyLocalEdit();
      toast.success("README saved");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setReadmeSaving(false);
    }
  };

  const handleShowCanvas = () => {
    setActiveTab("canvas");
    toast.success("Showing the canvas");
  };

  const sampleDataPanel = (
    <SampleDataPanel
      datasets={datasets}
      selectedName={selectedDatasetName}
      onSelect={setSelectedDatasetName}
      onAdd={() => {
        setDatasetName("");
        setDatasetJson("{\n  \n}");
        setShowDatasetDialog(true);
      }}
      onEdit={(ds) => {
        setEditingDataset(ds.name);
        setEditJson(ds.json);
        setShowEditDataset(true);
      }}
      onDelete={(ds) => {
        setDatasets((prev) => prev.filter((d) => d.name !== ds.name));
        if (selectedDatasetName === ds.name) {
          setSelectedDatasetName(datasets[0]?.name ?? "");
        }
        toast.success("Dataset deleted");
      }}
    />
  );

  const controls = {
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
    versions,
    onNewVersion: () => setShowVersionDialog(true),
    openDiff,
    handleRestoreVersion,
    handleDeleteVersion,
  };

  const insertHelper = (text: string, back = 0) => {
    if (editorRef.current) {
      editorRef.current.insertAtCursor(text, back);
      return;
    }
    // Canvas only: no editor is mounted. Bring it back, then insert once it is.
    pendingInsert.current = { text, back };
    setLayout("side");
  };

  const editorPane = (padding: string) => (
    <div className={`flex h-full min-h-0 flex-col gap-2 ${padding}`}>
      <EditorPane
        ref={editorRef}
        className="flex-1"
        templateName={templateName}
        htmlCode={htmlCode}
        cssCode={cssCode}
        onHtmlChange={setHtmlCode}
        onCssChange={setCssCode}
        readme={readme}
        onReadmeChange={setReadme}
        readmeSaving={readmeSaving}
        onSaveReadme={() => void handleSaveReadme()}
        notices={<ClassWarnings html={debouncedHtml} />}
      />
      <DesignerActions onBarcode={() => setShowBarcodeDialog(true)} onSaveVersion={() => setShowVersionDialog(true)} />
    </div>
  );

  const canvas = (fill: boolean) => (
    <CanvasWorkspace
      fill={fill}
      html={debouncedHtml}
      css={debouncedCss}
      compiledCss={compiledCss}
      data={sampleData}
      pageWidthMm={pageWidth}
      pageHeightMm={pageHeight}
    />
  );

  return (
    // On desktop the page fills the viewport (see Layout) and each pane scrolls on its own.
    <div className="space-y-4 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:gap-4 lg:space-y-0">
      <PageHeader title={t("designer.title")} description={t("pages.designer")}>
        {isDesktop && <LayoutToggle value={layout} onChange={setLayout} />}
        <DesignerToolbar onNew={() => setShowNewTemplateDialog(true)} onSave={() => void handleSave()} onImportFile={handleImportFile} onExport={handleExport} />
      </PageHeader>

      <TemplateSyncBar
        templateName={templateName}
        remoteId={remoteId}
        publishedAt={publishedAt}
        templateUpdatedAt={templateUpdatedAt}
        readOnly={isReadOnly({ origin })}
        pending={pending}
        onPublish={() => void handlePublish()}
        onUnpublish={handleUnpublish}
        onSyncNow={() => void handleSyncNow()}
      />

      {isDesktop ? (
        <div className="flex min-h-0 flex-1 gap-4">
          {controlsExpanded ? (
            <aside aria-label="Designer controls" className="flex w-[280px] shrink-0 flex-col gap-2 overflow-y-auto">
              <button
                type="button"
                aria-label="Collapse controls"
                title="Collapse controls"
                onClick={() => setControlsExpanded(false)}
                className="flex h-7 shrink-0 items-center gap-1.5 self-start rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <PanelLeftClose className="h-3.5 w-3.5" aria-hidden="true" />
                Collapse
              </button>
              <ControlsAccordion
                {...controls}
                sampleData={sampleDataPanel}
                openSections={openSections}
                onOpenSectionsChange={setOpenSections}
                onInsertHelper={insertHelper}
              />
            </aside>
          ) : (
            <ControlsRail onOpenSection={openControlsSection} onExpand={() => setControlsExpanded(true)} />
          )}
          {layout === "canvas" ? (
            <div className="min-h-0 min-w-0 flex-1">{canvas(true)}</div>
          ) : (
            <ResizablePanelGroup
              key={layout}
              direction={layout === "stacked" ? "vertical" : "horizontal"}
              autoSaveId={`printninja.designer.split.${layout}`}
              className="min-w-0 flex-1"
            >
              <ResizablePanel id="editor" order={1} defaultSize={50} minSize={25}>
                {editorPane(layout === "stacked" ? "pb-2" : "pr-2")}
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel id="canvas" order={2} defaultSize={50} minSize={25}>
                <div className={layout === "stacked" ? "h-full pt-2" : "h-full pl-2"}>{canvas(true)}</div>
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {/* Collapsed, so the canvas is not a long scroll away */}
          <ControlsAccordion {...controls} showHelpers={false} defaultOpen={[]} />

          <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
            <div className="min-w-0 overflow-x-auto">
              <TabsList aria-label="Designer views" className="h-8 w-max gap-0.5 p-0.5">
                <TabsTrigger value="canvas" className="h-7 px-3 text-xs">{t("designer.canvas")}</TabsTrigger>
                <TabsTrigger value="code" className="h-7 px-3 text-xs">{t("designer.code")}</TabsTrigger>
                <TabsTrigger value="readme" className="h-7 px-3 text-xs">README</TabsTrigger>
                <TabsTrigger value="sample-data" className="h-7 px-3 text-xs">{t("designer.sampleData")}</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value={activeTab} className="mt-0 space-y-4">
              {(activeTab === "canvas" || activeTab === "code") && <ClassWarnings html={debouncedHtml} />}
              {activeTab === "canvas" && canvas(false)}
              {activeTab === "code" && (
                <CodeEditors
                  templateName={templateName}
                  htmlCode={htmlCode}
                  cssCode={cssCode}
                  onHtmlChange={setHtmlCode}
                  onCssChange={setCssCode}
                />
              )}
              {activeTab === "readme" && (
                <Card>
                  <CardContent className="pt-5">
                    <ReadmePanel
                      readme={readme}
                      onChange={setReadme}
                      templateName={templateName}
                      saving={readmeSaving}
                      onSave={() => void handleSaveReadme()}
                    />
                  </CardContent>
                </Card>
              )}
              {activeTab === "sample-data" && (
                <Card>
                  <CardContent className="space-y-4 pt-5">
                    {sampleDataPanel}
                    <div className="space-y-2 border-t pt-3">
                      <h3 className="text-xs font-semibold">Helpers</h3>
                      <HelpersPanel />
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <DesignerActions
              onBarcode={() => setShowBarcodeDialog(true)}
              onSaveVersion={() => setShowVersionDialog(true)}
              onShowCanvas={handleShowCanvas}
            />
          </Tabs>
        </div>
      )}

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
                  <pre className="text-xs bg-muted p-2 rounded overflow-auto max-h-72 whitespace-pre-wrap">
                    {diff.html_from || "(empty)"}
                  </pre>
                </div>
                <div>
                  <p className="text-xs font-semibold mb-1">
                    v{diff.to_version_no} (after)
                  </p>
                  <pre className="text-xs bg-muted p-2 rounded overflow-auto max-h-72 whitespace-pre-wrap">
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
                    <pre className="text-xs bg-muted p-2 rounded overflow-auto max-h-48 whitespace-pre-wrap">
                      {diff.css_from || "(empty)"}
                    </pre>
                  </div>
                  <div>
                    <p className="text-xs font-semibold mb-1">
                      CSS v{diff.to_version_no}
                    </p>
                    <pre className="text-xs bg-muted p-2 rounded overflow-auto max-h-48 whitespace-pre-wrap">
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
              <Input data-testid="version-label" placeholder="e.g. Added logo" value={versionLabel} onChange={(e) => setVersionLabel(e.target.value)} />
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
                <p id="barcode-error" role="alert" className="text-xs text-danger">{barcodeError}</p>
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
              {(() => { try { JSON.parse(datasetJson); return null; } catch (e) { return <p className="text-xs text-danger">{String(e).split("\n")[0]}</p>; }})()}
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
            {(() => { try { JSON.parse(editJson); return null; } catch (e) { return <p className="text-xs text-danger">{String(e).split("\n")[0]}</p>; }})()}
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
