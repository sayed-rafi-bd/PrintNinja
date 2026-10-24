import { describeError } from "@/lib/errors";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { agent } from "@/lib/agent/commands";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Printer, Zap, CheckCircle2, XCircle, ChevronDown } from "lucide-react";
import { TimingBreakdown } from "@/components/TimingBreakdown";
import { formatSeconds } from "@/lib/timings";
import { cn } from "@/lib/utils";
import { useSystemPrinters } from "@/lib/hooks/useSystemPrinters";
import { PHONE_QUERY, useMediaQuery } from "@/lib/hooks/useMediaQuery";
import { toast } from "sonner";
import { usePrintStore } from "@/lib/store/printStore";
import { DEFAULT_MOCK_DATA } from "@/lib/templates/defaultTemplate";
import { ensureStarterTemplates } from "@/lib/templates/seedTemplates";
import type { StarterTemplate } from "@/lib/templates/seedTemplates";
import { compileTemplateCss } from "@/lib/templates/compileTemplateCss";
import { PrintPreview } from "@/components/PrintPreview";
import { resolvePaper } from "@/lib/render/printLayout";

/** Physical paper sheets offered as one-tap presets (mm). */
const PAPER_PRESETS = [
  { key: "a4", w: 210, h: 297, labelKey: "print.paper_a4" },
  { key: "letter", w: 216, h: 279, labelKey: "print.paper_letter" },
  { key: "photo", w: 100, h: 150, labelKey: "print.paper_photo" },
] as const;

export function PrintPage() {
  const { t } = useTranslation();
  const store = usePrintStore();
  const { printers, refresh: refreshSystemPrinters } = useSystemPrinters();
  const [templates, setTemplates] = useState<StarterTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  // One complete design document per record, laid out as in the Designer.
  // Paper, orientation, fit mode and margins are applied when drawing, so
  // changing them never re-renders the template.
  const [previewPages, setPreviewPages] = useState<string[]>([]);
  const [previewError, setPreviewError] = useState<string>("");
  const [previewNotice, setPreviewNotice] = useState<string>("");
  // Version ids already backfilled with compiled CSS this session, so the
  // preview effect does not write a "Compiled Tailwind CSS" version on
  // every render of the same template.
  const cssBackfilled = useRef<Set<number>>(new Set());
  // Phone-only layout: the sticky action bar below. Desktop keeps the single
  // in-card Print button (jsdom has no matchMedia, so tests see that one too).
  const isPhone = useMediaQuery(PHONE_QUERY);
  // Phone preview: collapsible, capped at ~40vh, tap to expand.
  // Desktop always shows the full preview, so these only matter on phones.
  const [previewOpen, setPreviewOpen] = useState(true);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const showPreviewBody = !isPhone || previewOpen;

  // Fetch printers + templates fresh every time (mount, sync pull,
  // window focus) so a height saved in Designer is visible here.
  useEffect(() => {
    let cancelled = false;
    const load = async (first: boolean) => {
      try {
        const [p, tpl] = await Promise.all([
          agent("enumerate_system_printers", {}).catch(() => []),
          ensureStarterTemplates(),
        ]);
        if (cancelled) return;
        setTemplates(tpl);
        const { printerId, templateId } = usePrintStore.getState();
        if (p.length > 0 && !printerId)
          usePrintStore.getState().setPrinterId(p[0].name);
        if (tpl.length > 0 && !templateId)
          usePrintStore.getState().setTemplateId(String(tpl[0].id));
      } catch (e) {
        console.error("Failed to load printers/templates:", e);
      } finally {
        if (first && !cancelled) setLoading(false);
      }
    };
    void load(true);
    const onPulled = () => void load(false);
    const onFocus = () => void load(false);
    window.addEventListener("sync:pulled", onPulled);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("sync:pulled", onPulled);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const selectedTemplate = useMemo(
    () => templates.find((x) => String(x.id) === store.templateId),
    [templates, store.templateId],
  );

  const selectedTemplateId = selectedTemplate?.id;
  // The template's orientation is the default; flipping the selector below
  // overrides it for this print only (never written back).
  useEffect(() => {
    if (selectedTemplate) {
      store.setOrientation(
        selectedTemplate.orientation === "landscape" ? "landscape" : "portrait",
      );
    }
    // Keyed on the template only: a reload must not clobber a manual flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTemplateId]);

  // The preview follows the selected template and data source, so
  // operators see what will print. With test data it renders the bundled
  // mock; otherwise it fetches the data URL (same GET/POST choice the
  // pipeline uses) and falls back to the mock with a notice when the
  // fetch fails.
  const dataUrl = store.dataUrl;
  const useTestData = store.useTestData;
  const httpMethod = store.httpMethod;
  const pageCount = Math.min(500, Math.max(1, Math.floor(store.records || 1)));
  const PREVIEW_PAGE_CAP = 10;
  useEffect(() => {
    const template = selectedTemplate;
    if (!template) {
      setPreviewPages([]);
      setPreviewError("");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const html = template.html ?? "";
        const css = template.css ?? "";
        if (!html.trim()) {
          if (!cancelled) {
            setPreviewPages([]);
            setPreviewError(t("print.preview_empty_template"));
          }
          return;
        }
        const { renderDesignPages } = await import(
          "@/lib/render/renderTemplate"
        );

        // Templates saved before per-template compilation have no stored
        // Tailwind CSS. Compile on the fly so the preview matches.
        let compiledCss = template.compiled_css ?? "";
        if (!compiledCss.trim() && !cssBackfilled.current.has(template.id)) {
          cssBackfilled.current.add(template.id);
          const built = await compileTemplateCss(html);
          compiledCss = built.css;
          if (built.css.trim() && !cancelled) {
            agent("update_template_meta", {
              req: {
                id: template.id,
                name: template.name,
                page_w_mm: template.page_w_mm,
                page_h_mm: template.page_h_mm,
                compiled_css: built.css,
                compiled_key: built.key,
              },
            }).catch((e) => console.warn("Could not store compiled CSS:", e));
          }
        }

        let data: unknown = DEFAULT_MOCK_DATA;
        let notice = "";
        if (!useTestData && dataUrl.trim()) {
          try {
            const res = await fetch(
              dataUrl.trim(),
              httpMethod === "POST"
                ? {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "{}",
                  }
                : undefined,
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            data = await res.json();
          } catch (e) {
            notice = t("print.preview_data_failed", {
              error: describeError(e),
            });
            data = DEFAULT_MOCK_DATA;
          }
        }

        if (Array.isArray(data) && data.length === 0) {
          if (!cancelled) {
            setPreviewPages([]);
            setPreviewError(t("print.preview_empty_data"));
            setPreviewNotice(notice);
          }
          return;
        }
        // One object repeats `records` times; an array prints its own
        // length. The preview shows at most a few pages so a big N stays
        // light — the print itself renders them all.
        const totalPages = Array.isArray(data) ? data.length : pageCount;
        const shownData = Array.isArray(data)
          ? data.slice(0, PREVIEW_PAGE_CAP)
          : Array<unknown>(Math.min(pageCount, PREVIEW_PAGE_CAP)).fill(data);
        if (totalPages > shownData.length) {
          notice += `${notice ? " " : ""}${t("print.preview_truncated", { shown: shownData.length, total: totalPages })}`;
        }

        if (!cancelled) {
          setPreviewPages(renderDesignPages(html, css, shownData, compiledCss));
          setPreviewError("");
          setPreviewNotice(notice);
        }
      } catch (e) {
        if (!cancelled) {
          setPreviewPages([]);
          setPreviewError(
            t("print.preview_unavailable", { error: describeError(e) }),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedTemplate, dataUrl, useTestData, httpMethod, pageCount]);

  const loadPrinters = async () => {
    try {
      const list = await refreshSystemPrinters();
      toast.success(t("printers.toast_found_system", { count: list.length }));
    } catch (e) {
      toast.error(t("settings_page.toast_failed", { error: describeError(e) }));
    }
  };

  const handlePrint = async () => {
    if (!store.printerId) {
      toast.error(t("print.blocker_printer"));
      return;
    }
    if (!store.templateId) {
      toast.error(t("print.blocker_template"));
      return;
    }
    if (store.copies < 1) {
      toast.error(t("print.blocker_copies"));
      return;
    }

    store.setStatus("printing");
    store.setError("");
    store.setTimings(null);

    try {
      const result = await agent("print_html", {
        req: {
          printer_name: store.printerId,
          html: "",
          template_id: Number(store.templateId),
          page_width_mm: effPaperW,
          page_height_mm: effPaperH,
          orientation: store.orientation,
          copies: store.copies,
          records: store.records,
          margin_top: store.marginTop,
          margin_right: store.marginRight,
          margin_bottom: store.marginBottom,
          margin_left: store.marginLeft,
          fit_mode: store.fitMode,
          page_range: store.pageRange.trim() || undefined,
          grayscale: store.grayscale,
          test: store.useTestData,
          source: store.useTestData ? "test" : "ui",
          data: store.useTestData ? DEFAULT_MOCK_DATA : undefined,
          data_url: store.useTestData ? undefined : store.dataUrl || undefined,
          http_method: store.useTestData ? undefined : store.httpMethod,
        },
      });

      // The result alert above the form reports the outcome; no toast.
      store.setDurationMs(result.duration_ms);
      store.setTimings(result.timings ?? null);
      if (result.success) {
        store.setStatus("success");
      } else {
        store.setStatus("failed");
        store.setError(result.error || "Unknown error");
      }
    } catch (e) {
      store.setStatus("failed");
      store.setError(describeError(e));
    }
  };

  const handleSpikeTest = async () => {
    store.setStatus("printing");
    store.setError("");
    store.setTimings(null);
    try {
      const result = await agent("spike_test_print", {});
      store.setDurationMs(result.duration_ms);
      store.setTimings(result.timings ?? null);
      if (result.success) {
        store.setStatus("success");
      } else {
        store.setStatus("failed");
        store.setError(result.error || "Unknown error");
      }
    } catch (e) {
      store.setStatus("failed");
      store.setError(describeError(e));
    }
  };

  const canPrint =
    !!store.printerId &&
    !!store.templateId &&
    store.copies >= 1 &&
    store.status !== "printing" &&
    !loading;
  const blocker = !store.printerId
    ? t("print.blocker_printer")
    : !store.templateId
      ? t("print.blocker_template")
      : store.status === "printing"
        ? t("print.blocker_running")
        : store.copies < 1
          ? t("print.blocker_copies")
          : loading
            ? t("print.blocker_loading")
            : "";
  const field = "space-y-1.5";

  // Paper presets: physical sheets. "auto" means the template's design
  // size; "custom" is edited in the inputs below.
  const designW = selectedTemplate?.page_w_mm ?? 80;
  const designH = selectedTemplate?.page_h_mm ?? 200;
  // Explicit paper size wins per axis; null falls back to the design size.
  // The paper is per-print only — never written back to the template.
  const effPaperW = store.paperW ?? designW;
  const effPaperH = store.paperH ?? designH;
  // The physical sheet the preview draws (and the PDF prints on): the same
  // mapping the backend applies, so orientation swaps the paper, never the
  // design.
  const { paperW: previewPaperW, paperH: previewPaperH } = resolvePaper(
    designW,
    designH,
    store.orientation,
    store.paperW,
    store.paperH,
  );
  const paperPreset =
    store.paperW == null && store.paperH == null
      ? "auto"
      : (PAPER_PRESETS.find((x) => x.w === store.paperW && x.h === store.paperH)
          ?.key ?? "custom");

  // Design size comes from the template; the paper size below overrides it
  // per axis (null = template size). All controls live inline in this card.
  const dataFields = (
    <>
      <div className={field}>
        <Label htmlFor="data-url">{t("print.data_url")}</Label>
        <Input
          id="data-url"
          placeholder={t("print.data_url_example")}
          value={store.dataUrl}
          onChange={(e) => store.setDataUrl(e.target.value)}
          disabled={store.useTestData}
        />
        <div className="flex items-center gap-2 pt-1">
          <Label
            htmlFor="http-method"
            className="text-xs text-muted-foreground"
          >
            {t("print.method_label")}
          </Label>
          <Select
            value={store.httpMethod}
            onValueChange={(v: "GET" | "POST") => store.setHttpMethod(v)}
            disabled={store.useTestData}
          >
            <SelectTrigger
              id="http-method"
              aria-label={t("print.method_aria")}
              className="h-7 w-[5.5rem] text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="GET">GET</SelectItem>
              <SelectItem value="POST">POST</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className={field}>
          <Label htmlFor="copies">{t("print.copies")}</Label>
          <Input
            id="copies"
            type="number"
            min="1"
            value={store.copies}
            onChange={(e) =>
              store.setCopies(
                Math.max(1, Math.floor(Number(e.target.value) || 1)),
              )
            }
          />
        </div>
        <div className={field}>
          <Label htmlFor="pages">{t("print.pages")}</Label>
          <Input
            id="pages"
            type="number"
            min="1"
            max="500"
            value={store.records}
            onChange={(e) => store.setRecords(Number(e.target.value))}
          />
        </div>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        {t("print.pages_hint")}
      </p>
    </>
  );

  return (
    <div className="space-y-4">
      <PageHeader title={t("print.title")} description={t("pages.print")}>
        <Button variant="outline" size="sm" onClick={loadPrinters}>
          {t("print.refresh")}
        </Button>
      </PageHeader>

      {/* The one place a print's outcome is reported. It is always shown: ready
          before the first print, then printing, then the result with its timing. */}
      {(store.status === "idle" || store.status === "queued") && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-lg border border-success/30 bg-success-soft px-4 py-3 text-success"
        >
          <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t("print.ready_title")}</p>
            <p className="break-words text-xs">
              {store.printerId
                ? t("print.ready_detail", { printer: store.printerId })
                : t("print.ready_empty")}
            </p>
          </div>
        </div>
      )}
      {store.status === "success" && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-lg border border-success/30 bg-success-soft px-4 py-3 text-success"
        >
          <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium">{t("print.sent")}</p>
            {store.timings ? (
              <TimingBreakdown timings={store.timings} />
            ) : (
              <p className="text-xs">
                {t("print.finished", {
                  seconds: formatSeconds(store.durationMs),
                })}
              </p>
            )}
          </div>
        </div>
      )}
      {store.status === "failed" && (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-danger"
        >
          <XCircle className="h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium">{t("print.failed_title")}</p>
            <p className="break-words text-xs">
              {store.error || t("print.unknown_error")}
            </p>
            {store.timings && <TimingBreakdown timings={store.timings} />}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handlePrint}
            disabled={!canPrint}
          >
            {t("print.retry")}
          </Button>
        </div>
      )}
      {store.status === "printing" && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-lg border border-info/30 bg-info-soft px-4 py-3 text-info"
        >
          <div
            className="h-5 w-5 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin"
            aria-hidden="true"
          />
          <p className="text-sm font-medium">{t("print.printing")}</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(340px,420px)_1fr]">
        {/* Left: choose and print */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("print.job_title")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className={field}>
                <Label htmlFor="print-printer">{t("print.printer")}</Label>
                <Select
                  value={store.printerId}
                  onValueChange={store.setPrinterId}
                >
                  <SelectTrigger
                    id="print-printer"
                    aria-label={t("print.printer")}
                  >
                    <SelectValue placeholder={t("print.printer_placeholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {printers.length === 0 && (
                      <SelectItem value="none" disabled>
                        {t("print.no_printers")}
                      </SelectItem>
                    )}
                    {printers.map((p) => (
                      <SelectItem key={p.id} value={p.name}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className={field}>
                <Label htmlFor="print-template">{t("print.template")}</Label>
                <Select
                  value={store.templateId}
                  onValueChange={store.setTemplateId}
                >
                  <SelectTrigger
                    id="print-template"
                    aria-label={t("print.template")}
                  >
                    <SelectValue
                      placeholder={t("print.template_placeholder")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.length === 0 && (
                      <SelectItem value="none" disabled>
                        {t("print.no_templates")}
                      </SelectItem>
                    )}
                    {templates.map((x) => (
                      <SelectItem key={x.id} value={String(x.id)}>
                        {x.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* "Use test data" stays put; the fields it replaces move into
                  {t("print.advanced")} so the first screen stays short. */}
              <div className="flex items-center justify-between">
                <Label htmlFor="test-data" className="font-normal">
                  {t("print.test_data")}
                </Label>
                <Switch
                  id="test-data"
                  checked={store.useTestData}
                  onCheckedChange={store.setUseTestData}
                />
              </div>
              {store.useTestData && (
                <p className="text-xs text-muted-foreground">
                  {t("print.sample_note", {
                    store: DEFAULT_MOCK_DATA.store.name,
                    order: DEFAULT_MOCK_DATA.order.id,
                  })}
                </p>
              )}
              {dataFields}

              {/* Layout controls live inline in this card, above the
                  Print button — no separate advanced section. */}
              <div className="grid grid-cols-2 gap-3">
                <div className={field}>
                  <Label htmlFor="print-orientation">
                    {t("print.orientation")}
                  </Label>
                  <Select
                    value={store.orientation}
                    onValueChange={(v) =>
                      store.setOrientation(v as "portrait" | "landscape")
                    }
                  >
                    <SelectTrigger
                      id="print-orientation"
                      aria-label={t("print.orientation")}
                    >
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
                <div className={field}>
                  <Label htmlFor="print-fit">{t("print.fit_mode")}</Label>
                  <Select
                    value={store.fitMode}
                    onValueChange={(v) =>
                      store.setFitMode(
                        v as
                          | "actual"
                          | "fit-width"
                          | "fit-page"
                          | "shrink"
                          | "fill",
                      )
                    }
                  >
                    <SelectTrigger
                      id="print-fit"
                      aria-label={t("print.fit_mode")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="actual">
                        {t("print.fit_actual")}
                      </SelectItem>
                      <SelectItem value="fit-width">
                        {t("print.fit_width")}
                      </SelectItem>
                      <SelectItem value="fit-page">
                        {t("print.fit_page")}
                      </SelectItem>
                      <SelectItem value="shrink">
                        {t("print.fit_shrink")}
                      </SelectItem>
                      <SelectItem value="fill">
                        {t("print.fit_fill")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className={field}>
                <Label htmlFor="print-paper">{t("print.paper_size")}</Label>
                <Select
                  value={paperPreset}
                  onValueChange={(v) => {
                    const preset = PAPER_PRESETS.find((x) => x.key === v);
                    if (!preset) {
                      // Custom: start from the current effective size so
                      // the inputs below are populated.
                      store.setPaperW(effPaperW);
                      store.setPaperH(effPaperH);
                      return;
                    }
                    store.setPaperW(preset.w);
                    store.setPaperH(preset.h);
                  }}
                >
                  <SelectTrigger
                    id="print-paper"
                    aria-label={t("print.paper_size")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">
                      {t("print.paper_auto")}
                    </SelectItem>
                    {PAPER_PRESETS.map((x) => (
                      <SelectItem key={x.key} value={x.key}>
                        {t(x.labelKey)}
                      </SelectItem>
                    ))}
                    <SelectItem value="custom">
                      {t("print.paper_custom")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {paperPreset === "custom" && (
                <div className="grid grid-cols-2 gap-3">
                  <div className={field}>
                    <Label htmlFor="paper-w">{t("print.paper_width")}</Label>
                    <Input
                      id="paper-w"
                      type="number"
                      min="1"
                      value={store.paperW ?? ""}
                      placeholder={String(designW)}
                      onChange={(e) =>
                        store.setPaperW(
                          e.target.value === ""
                            ? null
                            : Math.max(1, Number(e.target.value) || 1),
                        )
                      }
                    />
                  </div>
                  <div className={field}>
                    <Label htmlFor="paper-h">{t("print.paper_height")}</Label>
                    <Input
                      id="paper-h"
                      type="number"
                      min="1"
                      value={store.paperH ?? ""}
                      placeholder={String(designH)}
                      onChange={(e) =>
                        store.setPaperH(
                          e.target.value === ""
                            ? null
                            : Math.max(1, Number(e.target.value) || 1),
                        )
                      }
                    />
                  </div>
                </div>
              )}
              <p className="-mt-2 text-xs text-muted-foreground">
                {t("print.paper_note", {
                  dw: designW,
                  dh: designH,
                  pw: effPaperW,
                  ph: effPaperH,
                })}
              </p>
              <div className={field}>
                <Label htmlFor="page-range">{t("print.page_range")}</Label>
                <Input
                  id="page-range"
                  placeholder={t("print.page_range_example")}
                  value={store.pageRange}
                  onChange={(e) => store.setPageRange(e.target.value)}
                />
              </div>
              <fieldset className="space-y-1.5">
                <legend className="text-sm font-medium leading-none">
                  {t("print.margins")} (mm)
                </legend>
                <div className="grid grid-cols-4 gap-2 pt-1.5">
                  {(
                    [
                      [
                        "mt",
                        "print.margin_top",
                        store.marginTop,
                        store.setMarginTop,
                      ],
                      [
                        "mr",
                        "print.margin_right",
                        store.marginRight,
                        store.setMarginRight,
                      ],
                      [
                        "mb",
                        "print.margin_bottom",
                        store.marginBottom,
                        store.setMarginBottom,
                      ],
                      [
                        "ml",
                        "print.margin_left",
                        store.marginLeft,
                        store.setMarginLeft,
                      ],
                    ] as const
                  ).map(([id, key, value, set]) => (
                    <div key={id} className="space-y-1">
                      <Label
                        htmlFor={id}
                        className="text-xs font-normal text-muted-foreground"
                      >
                        {t(key)}
                      </Label>
                      <Input
                        id={id}
                        type="number"
                        value={value}
                        onChange={(e) => set(Number(e.target.value))}
                      />
                    </div>
                  ))}
                </div>
              </fieldset>
              <div className="flex items-center gap-2">
                <Switch
                  id="grayscale"
                  checked={store.grayscale}
                  onCheckedChange={store.setGrayscale}
                />
                <Label htmlFor="grayscale" className="font-normal">
                  {t("print.grayscale")}
                </Label>
              </div>
              <div className="border-t pt-3">
                <p className="mb-2 text-xs text-muted-foreground">
                  {t("print.test_hint")}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSpikeTest}
                  disabled={store.status === "printing"}
                >
                  <Zap className="h-4 w-4" aria-hidden="true" />
                  {t("print.send_test")}
                </Button>
              </div>

              <div className="space-y-2 pt-1">
                {/* Phone: the sticky bar owns the Print button (below). Two
                    buttons with the same name would break the tests' single
                    "Print" lookup, so this one is desktop/tablet only. */}
                {!isPhone && (
                  <Button
                    size="lg"
                    className="w-full"
                    onClick={handlePrint}
                    disabled={!canPrint}
                    title={blocker || undefined}
                    aria-describedby={blocker ? "print-blocker" : undefined}
                  >
                    <Printer className="h-5 w-5" aria-hidden="true" />
                    {store.status === "printing"
                      ? t("print.printing")
                      : t("print.print")}
                  </Button>
                )}
                {blocker && (
                  <p
                    id="print-blocker"
                    className="text-xs text-muted-foreground"
                  >
                    {blocker}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right: what will print */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div className="space-y-1">
                <CardTitle>{t("print.preview")}</CardTitle>
                <p className="text-xs text-muted-foreground">
                  {selectedTemplate
                    ? t("print.preview_subtitle", {
                        name: selectedTemplate.name,
                        w: selectedTemplate.page_w_mm,
                        h: selectedTemplate.page_h_mm,
                        source: t(
                          useTestData || !dataUrl.trim()
                            ? "print.preview_sample"
                            : "print.preview_live",
                        ),
                      })
                    : t("print.preview_empty")}
                </p>
                {selectedTemplate ? (
                  <p className="text-xs text-muted-foreground">
                    {t("print.paper_note", {
                      dw: designW,
                      dh: designH,
                      pw: effPaperW,
                      ph: effPaperH,
                    })}
                  </p>
                ) : null}
              </div>
              {isPhone && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-expanded={previewOpen}
                  aria-controls="print-preview-body"
                  aria-label={
                    previewOpen
                      ? t("print.preview_collapse")
                      : t("print.preview_expand")
                  }
                  onClick={() => setPreviewOpen((v) => !v)}
                >
                  <ChevronDown
                    className={cn(
                      "h-4 w-4 transition-transform",
                      previewOpen && "rotate-180",
                    )}
                    aria-hidden="true"
                  />
                </Button>
              )}
            </CardHeader>
            <CardContent
              id="print-preview-body"
              className={cn(!showPreviewBody && "hidden")}
            >
              {previewNotice && !previewError ? (
                <p className="mb-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning">
                  {previewNotice}
                </p>
              ) : null}
              {previewError ? (
                <p className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning">
                  {previewError}
                </p>
              ) : previewPages.length > 0 ? (
                <div
                  className={cn(
                    "overflow-auto rounded-md border bg-muted p-4",
                    // Phones: ~40vh until tapped, then most of the screen.
                    isPhone
                      ? previewExpanded
                        ? "max-h-[70vh]"
                        : "max-h-[40vh]"
                      : "max-h-[60vh]",
                  )}
                  tabIndex={0}
                  role="region"
                  aria-label={t("print.preview_region")}
                >
                  <PrintPreview
                    pages={previewPages}
                    designW={designW}
                    designH={designH}
                    paperW={previewPaperW}
                    paperH={previewPaperH}
                    margins={{
                      top: store.marginTop,
                      right: store.marginRight,
                      bottom: store.marginBottom,
                      left: store.marginLeft,
                    }}
                    fitMode={store.fitMode}
                    grayscale={store.grayscale}
                    title={t("print.preview_region")}
                  />
                </div>
              ) : (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {t("print.no_preview")}
                </p>
              )}
              {isPhone && previewPages.length > 0 && !previewError && (
                <Button
                  type="button"
                  variant="ghost"
                  className="mt-2 w-full"
                  aria-pressed={previewExpanded}
                  onClick={() => setPreviewExpanded((v) => !v)}
                >
                  {previewExpanded
                    ? t("print.preview_less")
                    : t("print.tap_expand")}
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Sticky action bar on phones: printer + Print always a thumb-reach
          away, above the bottom nav. */}
      {isPhone && (
        <div
          className="sticky bottom-0 z-10 -mx-4 border-t bg-card/95 px-4 pb-[env(safe-area-inset-bottom)] pt-2 backdrop-blur md:hidden"
          data-testid="print-action-bar"
        >
          <div className="flex items-center gap-2">
            <Select value={store.printerId} onValueChange={store.setPrinterId}>
              <SelectTrigger
                aria-label={t("print.printer")}
                className="min-h-11 min-w-0 flex-1"
              >
                <SelectValue placeholder={t("print.printer_placeholder")} />
              </SelectTrigger>
              <SelectContent>
                {printers.length === 0 && (
                  <SelectItem value="none" disabled>
                    No printers found
                  </SelectItem>
                )}
                {printers.map((p) => (
                  <SelectItem key={p.id} value={p.name}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="lg"
              className="min-h-11 shrink-0"
              onClick={handlePrint}
              disabled={!canPrint}
              title={blocker || undefined}
              aria-describedby={blocker ? "print-blocker-phone" : undefined}
            >
              <Printer className="h-5 w-5" aria-hidden="true" />
              {store.status === "printing"
                ? t("print.printing")
                : t("print.print")}
            </Button>
          </div>
          {blocker && (
            <p
              id="print-blocker-phone"
              className="mt-1 text-xs text-muted-foreground"
            >
              {blocker}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
