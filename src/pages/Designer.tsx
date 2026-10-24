import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/PageHeader";
import { ControlsAccordion } from "@/components/designer/ControlsAccordion";
import { CanvasWorkspace } from "@/components/designer/CanvasWorkspace";
import {
  CodeEditors,
  EditorPane,
  type EditorPaneHandle,
} from "@/components/designer/EditorPane";
import {
  ControlsRail,
  type ControlsSection,
} from "@/components/designer/ControlsRail";
import {
  LayoutToggle,
  isDesignerLayout,
  type DesignerLayout,
} from "@/components/designer/LayoutToggle";
import { DesignerActions } from "@/components/designer/DesignerActions";
import { DesignerToolbar } from "@/components/designer/DesignerToolbar";
import { HelpersPanel } from "@/components/designer/HelpersPanel";
import { ReadmePanel } from "@/components/designer/ReadmePanel";
import {
  SampleDataPanel,
  type Dataset,
} from "@/components/designer/SampleDataPanel";
import { ClassWarnings } from "@/components/designer/ClassWarnings";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  DESKTOP_QUERY,
  WIDE_QUERY,
  useMediaQuery,
} from "@/lib/hooks/useMediaQuery";
import { usePersistentState } from "@/lib/hooks/usePersistentState";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agent } from "@/lib/agent/commands";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { PanelLeftClose, QrCode, Save, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import {
  BARCODE_TYPES,
  buildBarcodeSnippet,
  isHelperSymbology,
} from "@/lib/utils/barcode";
import {
  DEFAULT_TEMPLATE_HTML,
  DEFAULT_TEMPLATE_CSS,
  DEFAULT_MOCK_DATA,
  STARTER_TEMPLATES,
} from "@/lib/templates/defaultTemplate";
import { useCompiledCss } from "@/lib/templates/useCompiledCss";
import { formatCss, formatHtml } from "@/lib/utils/format";
import { ensureStarterTemplates } from "@/lib/templates/seedTemplates";
import * as share from "@/lib/share/client";
import { useShareStatus } from "@/lib/shell/useShareStatus";
import { getLocalTemplate, isReadOnly } from "@/lib/share/sync";
import {
  createTemplateOnServer,
  saveTemplateToServer,
  overwriteWithMine,
  takeServerCopy,
  TemplateConflictError,
  type TemplateContent,
} from "@/lib/share/save";

const PAGE_PRESETS = [
  { labelKey: "designer.preset_a4", width: 210, height: 297 },
  { labelKey: "designer.preset_a5", width: 148, height: 210 },
  { labelKey: "designer.preset_letter", width: 216, height: 279 },
  { labelKey: "designer.preset_roll80", width: 80, height: 200 },
  { labelKey: "designer.preset_roll58", width: 58, height: 200 },
  { labelKey: "designer.preset_label4x6", width: 102, height: 152 },
];

/** Which sync action is running. */
type SyncAction = "save" | "visibility";

export function DesignerPage() {
  const { t } = useTranslation();
  const [showBarcodeDialog, setShowBarcodeDialog] = useState(false);
  const [barcodeType, setBarcodeType] = useState("code128");
  const [barcodeValue, setBarcodeValue] = useState("");
  // On: the value is a data field (order.id) read at print time. Off: fixed text.
  const [barcodeFromData, setBarcodeFromData] = useState(true);
  const [barcodeError, setBarcodeError] = useState<string | null>(null);
  const [showNewTemplateDialog, setShowNewTemplateDialog] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [htmlCode, setHtmlCode] = useState(DEFAULT_TEMPLATE_HTML);
  const [cssCode, setCssCode] = useState(DEFAULT_TEMPLATE_CSS);
  const [templateName, setTemplateName] = useState(STARTER_TEMPLATES[0].name);
  const [pageWidth, setPageWidth] = useState(
    STARTER_TEMPLATES[0]?.page_w_mm ?? 80,
  );
  const [pageHeight, setPageHeight] = useState(
    STARTER_TEMPLATES[0]?.page_h_mm ?? 200,
  );
  const [orientation, setOrientation] = useState<"portrait" | "landscape">(
    "portrait",
  );
  // Which tab is open on a phone. On desktop the canvas and editor are always both on screen.
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  // Desktop workspace preferences, remembered across launches.
  const [layout, setLayout] = usePersistentState<DesignerLayout>(
    "printninja.designer.layout",
    "side",
    isDesignerLayout,
  );
  const [openSections, setOpenSections] = usePersistentState<string[]>(
    "printninja.designer.openSections",
    ["page"],
    (v): v is string[] =>
      Array.isArray(v) && v.every((x) => typeof x === "string"),
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
    setOpenSections(
      openSections.includes(section)
        ? openSections
        : [...openSections, section],
    );
    setControlsExpanded(true);
  };
  const [activeTab, setActiveTab] = useState("canvas");
  // Phone: Templates / Page Setup / Custom input live in a bottom sheet
  // opened from a single Settings button.
  const [controlsOpen, setControlsOpen] = useState(false);
  const [readme, setReadme] = useState("");
  const [readmeSaving, setReadmeSaving] = useState(false);
  const [remoteId, setRemoteId] = useState<string | null>(null);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [origin, setOrigin] = useState<"own" | "saved">("own");
  const [pending, setPending] = useState<SyncAction | null>(null);
  // A save the server refused because its copy moved since this PC last
  // synced it. The dialog resolves it: take the server copy, or overwrite.
  const [conflict, setConflict] = useState<{
    rowId: number;
    serverId: string;
  } | null>(null);
  // Offline the cache is view/print only: the server owns the copies, so
  // Save (and creating) has nowhere to go and stays disabled.
  const shareStatus = useShareStatus();
  const offline = shareStatus.state !== "online";
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
  const [currentTemplateId, setCurrentTemplateId] = useState<number | null>(
    null,
  );
  const [_templatesLoading, setTemplatesLoading] = useState(true);
  void _templatesLoading;

  // Template ids whose html/css in `templates` is already loaded into
  // the editor. `loadTemplate` writes content directly since rows carry
  // their own html/css.
  const contentLoaded = useRef<Set<number>>(new Set());

  // Sample datasets (variables). Persisted through the agent and
  // synced like templates; the built-in Sample Order is the fallback
  // when the cache holds none yet.
  const [datasets, setDatasets] = useState<
    Array<Dataset & { id?: number | null }>
  >([]);

  const loadDatasets = useCallback(async () => {
    try {
      const rows = (await agent("list_datasets", {})) ?? [];
      setDatasets(
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          json: r.data_json,
          isDefault: false,
        })),
      );
    } catch {
      /* web mode or backend unavailable: the fallback below applies */
    }
  }, []);

  useEffect(() => {
    void loadDatasets();
  }, [loadDatasets]);

  // A completed pull lands rows after mount; reload so the new content
  // shows with no manual step.
  useEffect(() => {
    const onPulled = () => void loadDatasets();
    window.addEventListener("sync:pulled", onPulled);
    return () => window.removeEventListener("sync:pulled", onPulled);
  }, [loadDatasets]);

  const visibleDatasets: Dataset[] =
    datasets.length > 0
      ? datasets
      : [
          {
            name: "Sample Order",
            json: JSON.stringify(DEFAULT_MOCK_DATA, null, 2),
            isDefault: true,
          },
        ];

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
    contentLoaded.current.add(tpl.id);
    if (tpl.page_w_mm) setPageWidth(tpl.page_w_mm);
    if (tpl.page_h_mm) setPageHeight(tpl.page_h_mm);
    if (tpl.orientation)
      setOrientation(tpl.orientation as "portrait" | "landscape");
    setCurrentTemplateDbId(tpl.id);
    // Load readme and publish info if provided, otherwise fetch from DB
    if (tpl.readme !== undefined) {
      setReadme(tpl.readme);
      setRemoteId(tpl.server_id ?? tpl.remote_id ?? null);
      setPublishedAt(tpl.published_at ?? null);
      setOrigin((tpl.origin ?? "own") === "saved" ? "saved" : "own");
    } else {
      (async () => {
        try {
          const full = await agent("get_template", { id: tpl.id });
          setReadme(full.readme ?? "");
          setRemoteId(full.server_id ?? full.remote_id ?? null);
          setPublishedAt(full.published_at ?? null);
          setOrigin(full.origin === "saved" ? "saved" : "own");
        } catch {
          setReadme("");
          setRemoteId(null);
          setPublishedAt(null);
          setOrigin("own");
        }
      })();
    }
    // Content now lives on the template row itself; nothing more to load.
    toast.success(t("designer.toast_loaded", { name: tpl.name }));
  };

  /**
   * Save is the one way content reaches the server: a manual, blocking
   * push of the editor's state. Success records the copy the server
   * accepted; a revision conflict asks the user which copy wins; a
   * failed save leaves nothing behind to rot (the edit stays in the
   * editor, and the row keeps its old synced content).
   */
  const buildContent = async (): Promise<TemplateContent> => {
    const row = await getLocalTemplate(currentTemplateDbId!);
    return {
      name: templateName,
      summary: row.summary ?? "",
      page_w_mm: pageWidth,
      page_h_mm: pageHeight,
      html: htmlCode,
      css: cssCode,
      readme,
    };
  };

  const handleSave = async () => {
    if (!currentTemplateDbId) {
      toast.error(t("designer.toast_no_template"));
      return;
    }
    if (offline) {
      toast.error(t("designer.toast_offline_save"));
      return;
    }
    setPending("save");
    try {
      const row = await getLocalTemplate(currentTemplateDbId);
      if (isReadOnly(row)) {
        toast.error(t("designer.toast_readonly"));
        return;
      }
      const content = await buildContent();
      const result = await saveTemplateToServer(row, content);
      setRemoteId(result.remoteId);
      setPublishedAt(result.published ? result.updatedAt : null);
      setTemplates((prev) =>
        prev.map((t) =>
          t.id === currentTemplateDbId
            ? {
                ...t,
                name: content.name,
                html: content.html,
                css: content.css,
                page_w_mm: content.page_w_mm,
                page_h_mm: content.page_h_mm,
                orientation:
                  content.page_w_mm > content.page_h_mm
                    ? "landscape"
                    : "portrait",
              }
            : t,
        ),
      );
      setTemplateName(content.name);
      window.dispatchEvent(new Event("sync:pulled"));
      toast.success(
        result.published
          ? "Saved — the published copy is updated"
          : "Saved to the server",
      );
    } catch (e) {
      if (e instanceof TemplateConflictError) {
        setConflict({ rowId: currentTemplateDbId, serverId: e.serverId });
        return;
      }
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  /**
   * Publish is visibility-only: the switch calls publish/unpublish
   * immediately and updates the badge. Content still goes through Save,
   * except a never-pushed row is saved first so the server has a copy
   * to show or hide.
   */
  const handleVisibilityChange = async (makePublic: boolean) => {
    if (!currentTemplateDbId || offline) return;
    const row = await getLocalTemplate(currentTemplateDbId);
    if (isReadOnly(row)) return;
    const serverId = row.server_id ?? row.remote_id;
    if (!serverId) return;
    setPending("visibility");
    try {
      let id = serverId;
      if (row.base_revision == null) {
        const content = await buildContent();
        const saved = await saveTemplateToServer(row, content);
        id = saved.remoteId;
        setRemoteId(saved.remoteId);
        setPublishedAt(saved.published ? saved.updatedAt : null);
        setTemplates((prev) =>
          prev.map((t) =>
            t.id === currentTemplateDbId
              ? {
                  ...t,
                  name: content.name,
                  html: content.html,
                  css: content.css,
                  page_w_mm: content.page_w_mm,
                  page_h_mm: content.page_h_mm,
                  orientation:
                    content.page_w_mm > content.page_h_mm
                      ? "landscape"
                      : "portrait",
                }
              : t,
          ),
        );
      }
      if (makePublic) {
        const remote = await share.publishRemoteTemplate(id);
        setPublishedAt(remote.published_at ?? remote.updated_at ?? null);
        toast.success(t("designer.toast_now_public"));
      } else {
        await share.unpublishRemoteTemplate(id);
        setPublishedAt(null);
        toast.success(t("designer.toast_now_private"));
      }
      window.dispatchEvent(new Event("sync:pulled"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  /** Resolve a save conflict by taking the server's copy into the editor. */
  const resolveTakeServer = async () => {
    if (!conflict) return;
    const row = await getLocalTemplate(conflict.rowId);
    setPending("save");
    try {
      const taken = await takeServerCopy(row);
      setHtmlCode(formatHtml(taken.html));
      setCssCode(formatCss(taken.css));
      setTemplateName(taken.name);
      setPageWidth(taken.page_w_mm);
      setPageHeight(taken.page_h_mm);
      setReadme(taken.readme);
      setRemoteId(conflict.serverId);
      setPublishedAt(taken.updatedAt);
      setConflict(null);
      toast.success(t("designer.toast_server_copy"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  /** Resolve a save conflict by overwriting the server with this copy. */
  const resolveOverwrite = async () => {
    if (!conflict) return;
    setPending("save");
    try {
      const row = await getLocalTemplate(conflict.rowId);
      const content = await buildContent();
      const result = await overwriteWithMine(row, content);
      setRemoteId(result.remoteId);
      setPublishedAt(result.published ? result.updatedAt : null);
      setConflict(null);
      toast.success(t("designer.toast_overwrote"));
    } catch (e) {
      if (e instanceof TemplateConflictError) {
        toast.error(t("designer.toast_moved_again"));
        return;
      }
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  const createNewTemplate = async () => {
    const name = newTemplateName.trim();
    if (!name) {
      toast.error(t("designer.toast_name_required"));
      return;
    }
    if (templates.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      toast.error(t("designer.toast_name_exists"));
      return;
    }
    // Server-first: the server owns the copies, so a new template starts
    // there and is cached locally synced. Offline there is no creation.
    if (offline) {
      toast.error(t("designer.toast_offline_create"));
      return;
    }
    try {
      const created = await createTemplateOnServer({
        name,
        page_w_mm: STARTER_TEMPLATES[0].page_w_mm,
        page_h_mm: STARTER_TEMPLATES[0].page_h_mm,
        orientation: STARTER_TEMPLATES[0].orientation,
        html: DEFAULT_TEMPLATE_HTML,
        css: DEFAULT_TEMPLATE_CSS,
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
      contentLoaded.current.add(tpl.id);
      setTemplates((prev) => [...prev, tpl]);
      loadTemplate(tpl);
      setCurrentTemplateDbId(tpl.id);
      toast.success(t("designer.toast_created_server", { name }));
    } catch {
      // Web mode / DB unavailable — keep in-memory fallback so UI stays usable.
      const id = templates.length
        ? Math.max(...templates.map((t) => t.id)) + 1
        : 1;
      const tpl = {
        id,
        name,
        html: DEFAULT_TEMPLATE_HTML,
        css: DEFAULT_TEMPLATE_CSS,
        page_w_mm: STARTER_TEMPLATES[0].page_w_mm,
        page_h_mm: STARTER_TEMPLATES[0].page_h_mm,
        orientation: STARTER_TEMPLATES[0].orientation,
      };
      contentLoaded.current.add(tpl.id);
      setTemplates((prev) => [...prev, tpl]);
      loadTemplate(tpl);
      setCurrentTemplateDbId(tpl.id);
      toast.success(t("designer.toast_created_local", { name }));
    } finally {
      setNewTemplateName("");
      setShowNewTemplateDialog(false);
    }
  };
  const [selectedDatasetName, setSelectedDatasetName] =
    useState("Sample Order");
  const [showDatasetDialog, setShowDatasetDialog] = useState(false);
  const [datasetName, setDatasetName] = useState("");
  const [datasetJson, setDatasetJson] = useState("{\n  \n}");
  const [editingDataset, setEditingDataset] = useState<string | null>(null);
  const [editJson, setEditJson] = useState("");
  const [showEditDataset, setShowEditDataset] = useState(false);

  // The active template's DB row id (created on first save / on load).
  const [currentTemplateDbId, setCurrentTemplateDbId] = useState(1);

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
          const hydrated = rows.map((r) => ({
            id: r.id,
            name: r.name,
            html: r.html || DEFAULT_TEMPLATE_HTML,
            css: r.css || DEFAULT_TEMPLATE_CSS,
            page_w_mm: r.page_w_mm,
            page_h_mm: r.page_h_mm,
            orientation: r.orientation,
          }));
          setTemplates(hydrated);
          setCurrentTemplateId(hydrated[0].id);
          setTemplateName(hydrated[0].name);
          setHtmlCode(formatHtml(hydrated[0].html));
          setCssCode(formatCss(hydrated[0].css));
          setPageWidth(hydrated[0].page_w_mm ?? 80);
          setPageHeight(hydrated[0].page_h_mm ?? 200);
          setOrientation(
            (hydrated[0].orientation as "portrait" | "landscape") ?? "portrait",
          );
          setCurrentTemplateDbId(hydrated[0].id);
          // Load README and publish info for the first template
          try {
            const full = await agent("get_template", { id: hydrated[0].id });
            setReadme(full.readme ?? "");
            setRemoteId(full.server_id ?? full.remote_id ?? null);
            setPublishedAt(full.published_at ?? null);
            setOrigin(full.origin === "saved" ? "saved" : "own");
          } catch {
            setReadme("");
            setRemoteId(null);
            setPublishedAt(null);
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
          starters.forEach((t) => contentLoaded.current.add(t.id));
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
        starters.forEach((t) => contentLoaded.current.add(t.id));
        setTemplates(starters);
        setCurrentTemplateId(starters[0].id);
      } finally {
        if (!cancelled) setTemplatesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Templates reload on sync pulls so a save on another PC (or the
  // topbar sync button) refreshes this list without a remount.
  const currentTemplateDbIdRef = useRef(currentTemplateDbId);
  currentTemplateDbIdRef.current = currentTemplateDbId;
  useEffect(() => {
    const onPulled = async () => {
      try {
        const rows = await ensureStarterTemplates();
        if (!rows || rows.length === 0) return;
        setTemplates((prev) => {
          const byId = new Map(rows.map((r) => [r.id, r]));
          const next = prev.map((t) => {
            const r = byId.get(t.id);
            if (!r) return t;
            if (r.id === currentTemplateDbIdRef.current) {
              return {
                ...t,
                name: r.name,
                page_w_mm: r.page_w_mm,
                page_h_mm: r.page_h_mm,
                orientation: r.orientation,
              };
            }
            return {
              ...t,
              name: r.name,
              html: r.html || t.html,
              css: r.css || t.css,
              page_w_mm: r.page_w_mm,
              page_h_mm: r.page_h_mm,
              orientation: r.orientation,
            };
          });
          for (const r of rows) {
            if (!next.some((t) => t.id === r.id)) {
              next.push({
                id: r.id,
                name: r.name,
                html: r.html || DEFAULT_TEMPLATE_HTML,
                css: r.css || DEFAULT_TEMPLATE_CSS,
                page_w_mm: r.page_w_mm,
                page_h_mm: r.page_h_mm,
                orientation: r.orientation,
              });
            }
          }
          return next;
        });
      } catch {
        /* keep current list on failure */
      }
    };
    window.addEventListener("sync:pulled", onPulled);
    return () => window.removeEventListener("sync:pulled", onPulled);
  }, []);

  const handleInsertBarcode = () => {
    const snippet = buildBarcodeSnippet(
      barcodeType,
      barcodeValue,
      barcodeFromData && isHelperSymbology(barcodeType),
    );
    if (!snippet.ok) {
      setBarcodeError(
        t(
          snippet.messageKey,
          snippet.messageParams as Record<string, string> | undefined,
        ),
      );
      return;
    }
    insertHelper(
      snippet.kind === "static" ? "\n" + snippet.text : snippet.text,
    );
    setShowBarcodeDialog(false);
    setBarcodeValue("");
    setBarcodeError(null);
    toast.success(t("designer.toast_barcode_inserted", { type: barcodeType }));
  };

  const sampleData = useMemo<Record<string, unknown>>(() => {
    try {
      const ds =
        visibleDatasets.find((d) => d.name === selectedDatasetName) ??
        visibleDatasets[0];
      return JSON.parse(ds.json);
    } catch {
      return DEFAULT_MOCK_DATA as Record<string, unknown>;
    }
  }, [visibleDatasets, selectedDatasetName]);

  const handleSaveReadme = async () => {
    if (!currentTemplateDbId) {
      toast.error(t("designer.toast_no_template"));
      return;
    }
    const bytes = new TextEncoder().encode(readme).length;
    if (bytes > 64 * 1024) {
      toast.error(t("designer.toast_readme_too_big"));
      return;
    }
    setReadmeSaving(true);
    try {
      await agent("update_readme", {
        req: { id: currentTemplateDbId, readme },
      });
      // The README rides along with the next Save; nothing to send here.
      toast.success(t("designer.toast_readme_saved"));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setReadmeSaving(false);
    }
  };

  const handleShowCanvas = () => {
    setActiveTab("canvas");
    toast.success(t("designer.toast_showing_canvas"));
  };

  const sampleDataPanel = (
    <SampleDataPanel
      datasets={visibleDatasets}
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
        void (async () => {
          try {
            const row = datasets.find((d) => d.name === ds.name);
            if (row?.id != null) {
              await agent("delete_dataset", { id: row.id });
            }
            await loadDatasets();
            if (selectedDatasetName === ds.name) {
              setSelectedDatasetName(visibleDatasets[0]?.name ?? "");
            }
            toast.success(t("designer.toast_dataset_deleted"));
          } catch (e) {
            toast.error(
              t("designer.toast_delete_failed", { error: String(e) }),
            );
          }
        })();
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
    onBarcode: () => setShowBarcodeDialog(true),
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
        samplePanel={sampleDataPanel}
      />
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
        <DesignerToolbar
          onNew={() => setShowNewTemplateDialog(true)}
          onSave={() => void handleSave()}
          saveDisabled={offline || isReadOnly({ origin })}
          saveTitle={
            offline ? "Offline — connect to save to the server" : undefined
          }
          remoteId={remoteId}
          publishedAt={publishedAt}
          readOnly={isReadOnly({ origin })}
          pending={pending}
          onVisibilityChange={(v) => void handleVisibilityChange(v)}
        />
      </PageHeader>

      {isDesktop ? (
        <div className="flex min-h-0 flex-1 gap-4">
          {controlsExpanded ? (
            <aside
              aria-label={t("designer.controls_expanded")}
              className="flex w-[280px] shrink-0 flex-col gap-2 overflow-y-auto"
            >
              <button
                type="button"
                aria-label={t("designer.collapse_controls")}
                title={t("designer.collapse_controls")}
                onClick={() => setControlsExpanded(false)}
                className="flex h-7 shrink-0 items-center gap-1.5 self-start rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <PanelLeftClose className="h-3.5 w-3.5" aria-hidden="true" />
                {t("designer.collapse_short")}
              </button>
              <ControlsAccordion
                {...controls}
                openSections={openSections}
                onOpenSectionsChange={setOpenSections}
                onInsertHelper={insertHelper}
              />
            </aside>
          ) : (
            <ControlsRail
              onOpenSection={openControlsSection}
              onExpand={() => setControlsExpanded(true)}
            />
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
              <ResizablePanel
                id="editor"
                order={1}
                defaultSize={50}
                minSize={25}
              >
                {editorPane(layout === "stacked" ? "pb-2" : "pr-2")}
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel
                id="canvas"
                order={2}
                defaultSize={50}
                minSize={25}
              >
                <div
                  className={
                    layout === "stacked" ? "h-full pt-2" : "h-full pl-2"
                  }
                >
                  {canvas(true)}
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {/* The canvas is the first thing on screen: controls live in a
              bottom sheet opened from this single button. */}
          <Button
            variant="outline"
            className="w-full"
            onClick={() => setControlsOpen(true)}
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
            {t("designer.settings")}
          </Button>
          <Sheet open={controlsOpen} onOpenChange={setControlsOpen}>
            <SheetContent
              side="bottom"
              className="flex max-h-[85dvh] w-full flex-col gap-0 p-0 pb-[env(safe-area-inset-bottom)]"
            >
              <DialogHeader className="border-b p-5 pr-12">
                <DialogTitle>{t("designer.settings")}</DialogTitle>
                <DialogDescription>
                  {t("designer.settings_description")}
                </DialogDescription>
              </DialogHeader>
              <div className="flex-1 overflow-y-auto p-5">
                <ControlsAccordion
                  {...controls}
                  showHelpers={false}
                  defaultOpen={[]}
                />
              </div>
              <DialogFooter className="gap-2 border-t p-5 sm:space-x-0">
                <Button onClick={() => setControlsOpen(false)}>
                  {t("designer.sheet_done")}
                </Button>
              </DialogFooter>
            </SheetContent>
          </Sheet>

          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="space-y-4"
          >
            {/* Sticky view tabs + Save, so switching views and saving the
                tweak never need a scroll-up. The header
                keeps the full toolbar; this is the reachable shortcut. */}
            <div className="sticky top-0 z-10 -mx-4 bg-background/95 px-4 py-2 backdrop-blur">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1 overflow-x-auto">
                  <TabsList
                    aria-label={t("designer.views_aria")}
                    className="min-h-8 w-max gap-0.5 p-0.5"
                  >
                    <TabsTrigger value="canvas" className="h-7 px-3 text-xs">
                      {t("designer.canvas")}
                    </TabsTrigger>
                    <TabsTrigger value="code" className="h-7 px-3 text-xs">
                      {t("designer.code")}
                    </TabsTrigger>
                    <TabsTrigger value="readme" className="h-7 px-3 text-xs">
                      README
                    </TabsTrigger>
                    <TabsTrigger
                      value="sample-data"
                      className="h-7 px-3 text-xs"
                    >
                      {t("designer.sampleData")}
                    </TabsTrigger>
                  </TabsList>
                </div>
                {!isReadOnly({ origin }) && (
                  <Button
                    size="sm"
                    className="shrink-0"
                    onClick={() => void handleSave()}
                    disabled={offline || pending != null}
                  >
                    <Save className="h-4 w-4" aria-hidden="true" />
                    {t("common.save")}
                  </Button>
                )}
              </div>
            </div>

            <TabsContent value={activeTab} className="mt-0 space-y-4">
              {(activeTab === "canvas" || activeTab === "code") && (
                <ClassWarnings html={debouncedHtml} />
              )}
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
                      <h3 className="text-xs font-semibold">
                        {t("designer.helpers")}
                      </h3>
                      <HelpersPanel />
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <DesignerActions onShowCanvas={handleShowCanvas} />
          </Tabs>
        </div>
      )}

      {/* Barcode Dialog */}
      <Dialog open={showBarcodeDialog} onOpenChange={setShowBarcodeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("designer.barcode_title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="barcode-type">{t("designer.barcode_type")}</Label>
              <Select value={barcodeType} onValueChange={setBarcodeType}>
                <SelectTrigger id="barcode-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BARCODE_TYPES.map((bc) => (
                    <SelectItem key={bc.value} value={bc.value}>
                      {bc.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="barcode-from-data" className="text-sm">
                {t("designer.barcode_from_data")}
              </Label>
              <Switch
                id="barcode-from-data"
                checked={barcodeFromData && isHelperSymbology(barcodeType)}
                disabled={!isHelperSymbology(barcodeType)}
                onCheckedChange={(on) => {
                  setBarcodeFromData(on);
                  setBarcodeError(null);
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="barcode-value">
                {barcodeFromData && isHelperSymbology(barcodeType)
                  ? t("designer.barcode_field")
                  : t("designer.barcode_value")}
              </Label>
              <Input
                id="barcode-value"
                placeholder={
                  barcodeFromData && isHelperSymbology(barcodeType)
                    ? t("designer.barcode_field_example")
                    : t("designer.barcode_value_hint")
                }
                value={barcodeValue}
                onChange={(e) => {
                  setBarcodeValue(e.target.value);
                  setBarcodeError(null);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {!isHelperSymbology(barcodeType)
                  ? t("designer.barcode_fixed_hint")
                  : barcodeFromData
                    ? t("designer.barcode_per_print")
                    : t("designer.barcode_same")}
              </p>
              {barcodeError && (
                <p
                  id="barcode-error"
                  role="alert"
                  className="text-xs text-danger"
                >
                  {barcodeError}
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowBarcodeDialog(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              id="barcode-insert"
              onClick={handleInsertBarcode}
              disabled={!barcodeValue}
            >
              <QrCode className="h-4 w-4" />
              {t("designer.barcode_insert")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Dataset Dialog */}
      <Dialog open={showDatasetDialog} onOpenChange={setShowDatasetDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("designer.sample_add_title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t("common.name")}</Label>
              <Input
                value={datasetName}
                onChange={(e) => setDatasetName(e.target.value)}
                placeholder={t("designer.sample_name_example")}
              />
            </div>
            <div className="space-y-1">
              <Label>{t("designer.sample_json_label")}</Label>
              <div className="rounded-md border overflow-hidden">
                <CodeMirror
                  value={datasetJson}
                  height="160px"
                  extensions={[json()]}
                  onChange={setDatasetJson}
                  theme="dark"
                  basicSetup={{ lintKeymap: true }}
                />
              </div>
              {(() => {
                try {
                  JSON.parse(datasetJson);
                  return null;
                } catch (e) {
                  return (
                    <p className="text-xs text-danger">
                      {String(e).split("\n")[0]}
                    </p>
                  );
                }
              })()}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDatasetDialog(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => {
                if (!datasetName.trim()) {
                  toast.error(t("designer.toast_dataset_name_required"));
                  return;
                }
                try {
                  JSON.parse(datasetJson);
                } catch {
                  toast.error(t("designer.toast_invalid_json"));
                  return;
                }
                void (async () => {
                  try {
                    await agent("save_dataset", {
                      req: { name: datasetName, data_json: datasetJson },
                    });
                    await loadDatasets();
                    setShowDatasetDialog(false);
                    toast.success(
                      t("designer.toast_dataset_added", { name: datasetName }),
                    );
                  } catch (e) {
                    toast.error(
                      t("designer.toast_add_failed", { error: String(e) }),
                    );
                  }
                })();
              }}
            >
              {t("common.add")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dataset Dialog */}
      <Dialog open={showEditDataset} onOpenChange={setShowEditDataset}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("designer.sample_edit_title", { name: editingDataset })}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md border overflow-hidden">
              <CodeMirror
                value={editJson}
                height="200px"
                extensions={[json()]}
                onChange={setEditJson}
                theme="dark"
              />
            </div>
            {(() => {
              try {
                JSON.parse(editJson);
                return null;
              } catch (e) {
                return (
                  <p className="text-xs text-danger">
                    {String(e).split("\n")[0]}
                  </p>
                );
              }
            })()}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditDataset(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => {
                try {
                  JSON.parse(editJson);
                } catch {
                  toast.error(t("designer.toast_invalid_json"));
                  return;
                }
                void (async () => {
                  try {
                    const row = datasets.find((d) => d.name === editingDataset);
                    await agent("save_dataset", {
                      req: {
                        id: row?.id ?? null,
                        name: editingDataset ?? "",
                        data_json: editJson,
                      },
                    });
                    await loadDatasets();
                    setShowEditDataset(false);
                    toast.success(t("designer.toast_dataset_updated"));
                  } catch (e) {
                    toast.error(
                      t("designer.toast_save_failed", { error: String(e) }),
                    );
                  }
                })();
              }}
            >
              {t("designer.sample_save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Template Dialog */}
      <Dialog
        open={showNewTemplateDialog}
        onOpenChange={setShowNewTemplateDialog}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("designer.newTemplate")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t("designer.template_name")}</Label>
              <Input
                placeholder={t("designer.new_name_example")}
                value={newTemplateName}
                onChange={(e) => setNewTemplateName(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowNewTemplateDialog(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={createNewTemplate}>
              {t("designer.new_create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Save conflict: the server copy moved since this PC last synced
          it. Two ways out, both explicit — nothing is chosen for the
          user, and nothing is queued to resolve later. */}
      <Dialog
        open={conflict !== null}
        onOpenChange={(open) => {
          if (!open) setConflict(null);
        }}
      >
        <DialogContent data-testid="save-conflict-dialog">
          <DialogHeader>
            <DialogTitle>{t("designer.conflict_title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("designer.conflict_body")}
          </p>
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button
              data-testid="save-conflict-overwrite"
              onClick={() => void resolveOverwrite()}
              disabled={pending !== null}
            >
              {pending === "save"
                ? t("designer.conflict_overwriting")
                : t("designer.conflict_overwrite")}
            </Button>
            <Button
              data-testid="save-conflict-take-server"
              variant="outline"
              onClick={() => void resolveTakeServer()}
              disabled={pending !== null}
            >
              {pending === "save"
                ? t("designer.conflict_loading")
                : t("designer.conflict_take_server")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
