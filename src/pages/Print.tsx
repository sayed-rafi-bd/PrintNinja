import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { invoke } from "@/lib/invoke";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Printer, Zap, CheckCircle2, XCircle, Play, ChevronDown } from "lucide-react";
import { JobStatusBadge } from "@/components/StatusBadge";
import { cn } from "@/lib/utils";
import { useSystemPrinters } from "@/lib/hooks/useSystemPrinters";
import { toast } from "sonner";
import { usePrintStore } from "@/lib/store/printStore";
import { DEFAULT_MOCK_DATA } from "@/lib/templates/defaultTemplate";
import { ensureStarterTemplates, type TemplateRow } from "@/lib/templates/seedTemplates";
import { compileTemplateCss } from "@/lib/templates/compileTemplateCss";
interface PrintResponse {
  success: boolean;
  job_id: string;
  duration_ms: number;
  error?: string;
}

interface PrinterInfo {
  id: string;
  name: string;
  address: string;
  printer_type: string;
  language: string;
  status?: string;
}

const MM_TO_PX = 3.7795;

export function PrintPage() {
  const { t } = useTranslation();
  const store = usePrintStore();
  const { printers, refresh: refreshSystemPrinters } = useSystemPrinters();
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showBatchDialog, setShowBatchDialog] = useState(false);
  const [batchInput, setBatchInput] = useState("");
  const [batchCsvFile, setBatchCsvFile] = useState<File | null>(null);
  const [batchCsvPreview, setBatchCsvPreview] = useState<Array<Record<string, string>> | null>(null);
  const [batchCsvHeaders, setBatchCsvHeaders] = useState<string[]>([]);
  const [batches, setBatches] = useState<Array<{ id: number; total: number; done: number; failed: number; mode: string; status: string }>>([]);

  const [previewHtml, setPreviewHtml] = useState<string>("");
  const [previewError, setPreviewError] = useState<string>("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showBatches, setShowBatches] = useState(false);

  // Fetch printers + templates once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [p, tpl] = await Promise.all([
          invoke<PrinterInfo[]>("enumerate_system_printers").catch(() => []),
          ensureStarterTemplates(),
        ]);
        if (cancelled) return;
        setTemplates(tpl);
        const { printerId, templateId } = usePrintStore.getState();
        if (p.length > 0 && !printerId) usePrintStore.getState().setPrinterId(p[0].name);
        if (tpl.length > 0 && !templateId)
          usePrintStore.getState().setTemplateId(String(tpl[0].id));
      } catch (e) {
        console.error("Failed to load printers/templates:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedTemplate = useMemo(
    () => templates.find((x) => String(x.id) === store.templateId),
    [templates, store.templateId],
  );

  // The preview follows the selected template, so operators see what will print.
  useEffect(() => {
    const template = selectedTemplate;
    if (!template) { setPreviewHtml(""); setPreviewError(""); return; }
    let cancelled = false;
    (async () => {
      try {
        const versions = await invoke<{ id: number; html: string; css: string; compiled_css?: string }[]>("list_versions", { templateId: template.id });
        const latest = versions?.[0];
        if (!latest) { if (!cancelled) { setPreviewHtml(""); setPreviewError("This template has no versions yet. Open it in Designer and save it."); } return; }
        const { renderTemplate } = await import("@/lib/render/renderTemplate");

        // A version saved before per-template compilation existed (or whose
        // compile failed) has no stored Tailwind CSS. Compile it now so the
        // preview matches the Designer, and save the result so the actual
        // print job (which reads the stored stylesheet) is styled too.
        let compiledCss = latest.compiled_css ?? "";
        if (!compiledCss.trim()) {
          const built = await compileTemplateCss(latest.html);
          compiledCss = built.css;
          if (built.css.trim() && !cancelled) {
            invoke("create_version", {
              req: {
                template_id: template.id,
                html: latest.html,
                css: latest.css,
                compiled_css: built.css,
                compiled_key: built.key,
                label: null,
                note: "Compiled Tailwind CSS",
                created_by: "autosave",
              },
            }).catch((e) => console.warn("Could not store compiled CSS:", e));
          }
        }

        if (!cancelled) {
          setPreviewHtml(renderTemplate(latest.html, latest.css, DEFAULT_MOCK_DATA as any, compiledCss));
          setPreviewError("");
        }
      } catch (e) {
        if (!cancelled) { setPreviewHtml(""); setPreviewError(`Preview unavailable: ${e}`); }
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTemplate]);

  const refreshBatches = async () => {
    try {
      const list = await invoke<Array<{ id: number; total: number; done: number; failed: number; mode: string; status: string }>>("list_batches");
      setBatches(list ?? []);
    } catch {}
  };
  useEffect(() => {
    refreshBatches();
    const id = setInterval(refreshBatches, 5000);
    return () => clearInterval(id);
  }, [showBatchDialog]);

  const parseCsv = (text: string): { headers: string[]; rows: string[][] } => {
    const lines: string[][] = [];
    let cur = "";
    let row: string[] = [];
    let inQuote = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        if (inQuote && text[i + 1] === '"') { cur += '"'; i++; } else { inQuote = !inQuote; }
      } else if (c === "," && !inQuote) { row.push(cur.trim()); cur = ""; }
      else if ((c === "\n" || c === "\r") && !inQuote) {
        if (cur !== "" || row.length > 0) { row.push(cur.trim()); cur = ""; lines.push(row); row = []; }
        if (c === "\r" && text[i + 1] === "\n") i++;
      } else { cur += c; }
    }
    if (cur !== "" || row.length > 0) { row.push(cur.trim()); lines.push(row); }
    if (lines.length === 0) return { headers: [], rows: [] };
    const headers = lines[0].map((h) => h.trim());
    return { headers, rows: lines.slice(1) };
  };

  const handleCsvUpload = async (file: File) => {
    setBatchCsvFile(file);
    try {
      const text = await file.text();
      const { headers, rows } = parseCsv(text);
      if (headers.length === 0) { toast.error("CSV has no header row"); return; }
      setBatchCsvHeaders(headers);
      const jsonRows = rows.filter((r) => r.some((c) => c !== "")).map((r) => {
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => { obj[h] = r[i] ?? ""; });
        return obj;
      });
      setBatchCsvPreview(jsonRows.slice(0, 5));
      setBatchInput(JSON.stringify(jsonRows, null, 2));
      toast.success(`CSV loaded: ${jsonRows.length} row(s), ${headers.length} column(s)`);
    } catch (e) {
      toast.error(`CSV parse failed: ${e}`);
    }
  };

  const handleBatchPrint = async () => {
    if (!batchInput.trim()) {
      toast.error("Please enter batch data or upload CSV");
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(batchInput);
    } catch {
      toast.error("Invalid JSON");
      return;
    }
    if (!Array.isArray(data)) {
      toast.error("Batch data must be a JSON array (CSV is converted to array)");
      return;
    }
    if (!store.templateId) { toast.error("Select a template first"); return; }
    if (!store.printerId) { toast.error("Select a printer first"); return; }
    const printer = printers.find((p) => p.name === store.printerId);
    let printerId = printer ? Number((printer as unknown as { id: number }).id) || 0 : 0;
    if (!printerId) {
      try {
        const all = await invoke<Array<{ id: number; name: string }>>("list_printers");
        const match = all.find((p) => p.name === store.printerId);
        if (match) printerId = match.id;
      } catch {}
    }
    if (!printerId) { toast.error("Could not resolve printer — re-select it"); return; }
    try {
      await invoke("create_batch", {
        req: {
          template_id: Number(store.templateId) || 0,
          printer_id: printerId,
          data,
          mode: store.batchMode2,
        },
      });
      toast.success(`Batch queued: ${(data as unknown[]).length} record(s)`);
      setShowBatchDialog(false);
      setBatchInput("");
      setBatchCsvFile(null);
      setBatchCsvPreview(null);
      refreshBatches();
    } catch (e) {
      toast.error(`Batch failed: ${e}`);
    }
  };

  const handleCancelBatch = async (id: number) => {
    try { await invoke("cancel_batch", { id }); toast.success(`Batch #${id} cancelled`); refreshBatches(); } catch (e) { toast.error(String(e)); }
  };
  const handleRetryBatch = async (id: number) => {
    try { await invoke("retry_batch", { id }); toast.success(`Batch #${id} retry queued`); refreshBatches(); } catch (e) { toast.error(String(e)); }
  };

  const loadPrinters = async () => {
    try {
      const list = await refreshSystemPrinters();
      toast.success(`Found ${list.length} printer(s)`);
    } catch (e) {
      toast.error(`Failed: ${e}`);
    }
  };

  const handlePrint = async () => {
    if (!store.printerId) {
      toast.error("Please select a printer");
      return;
    }
    if (!store.templateId) {
      toast.error("Please select a template");
      return;
    }
    if (store.copies < 1) {
      toast.error("Copies must be at least 1");
      return;
    }

    store.setStatus("printing");
    store.setError("");

    try {
      const result = await invoke<PrintResponse>("print_html", {
        req: {
          printer_name: store.printerId,
          html: "",
          template_id: Number(store.templateId),
          page_width_mm: selectedTemplate?.page_w_mm ?? 210,
          page_height_mm: selectedTemplate?.page_h_mm ?? 297,
          orientation: store.orientation,
          copies: store.copies,
          margin_top: store.marginTop,
          margin_right: store.marginRight,
          margin_bottom: store.marginBottom,
          margin_left: store.marginLeft,
          fit_mode: store.fitMode,
          test: store.useTestData,
          source: store.useTestData ? "test" : "ui",
          data: store.useTestData ? DEFAULT_MOCK_DATA : undefined,
          data_url: store.useTestData ? undefined : store.dataUrl || undefined,
        },
      });

      store.setDurationMs(result.duration_ms);
      if (result.success) {
        store.setStatus("success");
        toast.success(`Printed in ${result.duration_ms}ms (job #${result.job_id})`);
      } else {
        store.setStatus("failed");
        store.setError(result.error || "Unknown error");
        toast.error(`Print failed: ${result.error}`);
      }
    } catch (e) {
      store.setStatus("failed");
      store.setError(String(e));
      toast.error(`Print failed: ${e}`);
    }
  };

  const handleSpikeTest = async () => {
    store.setStatus("printing");
    store.setError("");
    try {
      const result = await invoke<PrintResponse>("spike_test_print");
      store.setDurationMs(result.duration_ms);
      if (result.success) {
        store.setStatus("success");
        toast.success(`Spike test printed in ${result.duration_ms}ms`);
      } else {
        store.setStatus("failed");
        store.setError(result.error || "Unknown error");
      }
    } catch (e) {
      store.setStatus("failed");
      store.setError(String(e));
    }
  };

  const canPrint = !!store.printerId && !!store.templateId && store.copies >= 1 && store.status !== "printing" && !loading;
  const blocker = !store.printerId
    ? "Choose a printer to enable printing."
    : !store.templateId
      ? "Choose a template to enable printing."
      : "";
  const field = "space-y-1.5";

  return (
    <div className="space-y-4">
      <PageHeader title={t("print.title")} description={t("pages.print")}>
        <Button variant="outline" size="sm" onClick={loadPrinters}>
          Refresh printers
        </Button>
      </PageHeader>

      {/* Result of the last print, always in the same place */}
      {store.status === "success" && (
        <div role="status" className="flex items-center gap-3 rounded-lg border border-success/30 bg-success-soft px-4 py-3 text-success">
          <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="flex-1">
            <p className="text-sm font-medium">Print sent</p>
            <p className="text-xs">Finished in {store.durationMs} ms.</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => store.setStatus("idle")}>Dismiss</Button>
        </div>
      )}
      {store.status === "failed" && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-danger">
          <XCircle className="h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Print failed</p>
            <p className="break-words text-xs">{store.error || "Unknown error"}</p>
          </div>
          <Button variant="outline" size="sm" onClick={handlePrint} disabled={!canPrint}>Try again</Button>
          <Button variant="ghost" size="sm" onClick={() => store.setStatus("idle")}>Dismiss</Button>
        </div>
      )}
      {store.status === "printing" && (
        <div role="status" className="flex items-center gap-3 rounded-lg border border-info/30 bg-info-soft px-4 py-3 text-info">
          <div className="h-5 w-5 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin" aria-hidden="true" />
          <p className="text-sm font-medium">Printing…</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(340px,420px)_1fr]">
        {/* Left: choose and print */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Print job</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className={field}>
                <Label htmlFor="print-printer">{t("print.printer")}</Label>
                <Select value={store.printerId} onValueChange={store.setPrinterId}>
                  <SelectTrigger id="print-printer" aria-label="Printer">
                    <SelectValue placeholder="Select printer" />
                  </SelectTrigger>
                  <SelectContent>
                    {printers.length === 0 && <SelectItem value="none" disabled>No printers found</SelectItem>}
                    {printers.map((p) => (
                      <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className={field}>
                <Label htmlFor="print-template">{t("print.template")}</Label>
                <Select value={store.templateId} onValueChange={store.setTemplateId}>
                  <SelectTrigger id="print-template" aria-label="Template">
                    <SelectValue placeholder="Select template" />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.length === 0 && <SelectItem value="none" disabled>No templates. Create one in Designer.</SelectItem>}
                    {templates.map((x) => (
                      <SelectItem key={x.id} value={String(x.id)}>{x.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className={field}>
                <div className="flex items-center justify-between">
                  <Label htmlFor="data-url">{t("print.data_url")}</Label>
                  <div className="flex items-center gap-2">
                    <Label htmlFor="test-data" className="text-xs font-normal text-muted-foreground">Use test data</Label>
                    <Switch id="test-data" checked={store.useTestData} onCheckedChange={store.setUseTestData} />
                  </div>
                </div>
                <Input
                  id="data-url"
                  placeholder="https://api.example.com/orders/123"
                  value={store.dataUrl}
                  onChange={(e) => store.setDataUrl(e.target.value)}
                  disabled={store.useTestData}
                />
                {store.useTestData && (
                  <p className="text-xs text-muted-foreground">
                    Sample data: {DEFAULT_MOCK_DATA.store.name}, order #{DEFAULT_MOCK_DATA.order.id}
                  </p>
                )}
              </div>

              <div className={cn(field, "max-w-[8rem]")}>
                <Label htmlFor="copies">{t("print.copies")}</Label>
                <Input
                  id="copies"
                  type="number"
                  min="1"
                  value={store.copies}
                  onChange={(e) => store.setCopies(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                />
              </div>

              <div className="space-y-2 pt-1">
                <Button size="lg" className="w-full" onClick={handlePrint} disabled={!canPrint}>
                  <Printer className="h-5 w-5" aria-hidden="true" />
                  {store.status === "printing" ? "Printing…" : t("print.print")}
                </Button>
                {blocker && <p className="text-xs text-muted-foreground">{blocker}</p>}
              </div>
            </CardContent>
          </Card>

          {/* Advanced options stay out of the way until needed */}
          <Card>
            <button
              type="button"
              className="flex w-full items-center justify-between px-5 py-3 text-left text-sm font-semibold"
              aria-expanded={showAdvanced}
              aria-controls="print-advanced"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              Advanced options
              <ChevronDown className={cn("h-4 w-4 transition-transform", showAdvanced && "rotate-180")} aria-hidden="true" />
            </button>
            {showAdvanced && (
              <CardContent id="print-advanced" className="space-y-4 border-t pt-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className={field}>
                    <Label htmlFor="print-orientation">{t("print.orientation")}</Label>
                    <Select value={store.orientation} onValueChange={(v) => store.setOrientation(v as "portrait" | "landscape")}>
                      <SelectTrigger id="print-orientation" aria-label="Orientation"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="portrait">Portrait</SelectItem>
                        <SelectItem value="landscape">Landscape</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className={field}>
                    <Label htmlFor="print-fit">{t("print.fit_mode")}</Label>
                    <Select
                      value={store.fitMode}
                      onValueChange={(v) => store.setFitMode(v as "actual" | "fit-width" | "fit-page" | "shrink" | "fill")}
                    >
                      <SelectTrigger id="print-fit" aria-label="Fit mode"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="actual">{t("print.fit_actual")}</SelectItem>
                        <SelectItem value="fit-width">{t("print.fit_width")}</SelectItem>
                        <SelectItem value="fit-page">{t("print.fit_page")}</SelectItem>
                        <SelectItem value="shrink">{t("print.fit_shrink")}</SelectItem>
                        <SelectItem value="fill">{t("print.fit_fill")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className={field}>
                  <Label htmlFor="page-range">Page range</Label>
                  <Input id="page-range" placeholder="e.g. 1-5" value={store.pageRange} onChange={(e) => store.setPageRange(e.target.value)} />
                </div>
                <fieldset className="space-y-1.5">
                  <legend className="text-sm font-medium leading-none">{t("print.margins")} (mm)</legend>
                  <div className="grid grid-cols-4 gap-2 pt-1.5">
                    {([
                      ["mt", "print.margin_top", store.marginTop, store.setMarginTop],
                      ["mr", "print.margin_right", store.marginRight, store.setMarginRight],
                      ["mb", "print.margin_bottom", store.marginBottom, store.setMarginBottom],
                      ["ml", "print.margin_left", store.marginLeft, store.setMarginLeft],
                    ] as const).map(([id, key, value, set]) => (
                      <div key={id} className="space-y-1">
                        <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">{t(key)}</Label>
                        <Input id={id} type="number" value={value} onChange={(e) => set(Number(e.target.value))} />
                      </div>
                    ))}
                  </div>
                </fieldset>
                <div className="flex items-center gap-2">
                  <Switch id="grayscale" checked={store.grayscale} onCheckedChange={store.setGrayscale} />
                  <Label htmlFor="grayscale" className="font-normal">Grayscale</Label>
                </div>
                <div className="border-t pt-3">
                  <p className="mb-2 text-xs text-muted-foreground">Prints a built-in page to check the printer pipeline.</p>
                  <Button variant="outline" size="sm" onClick={handleSpikeTest} disabled={store.status === "printing"}>
                    <Zap className="h-4 w-4" aria-hidden="true" />
                    Send test page
                  </Button>
                </div>
              </CardContent>
            )}
          </Card>
        </div>

        {/* Right: what will print, then batches */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div className="space-y-1">
                <CardTitle>Preview</CardTitle>
                <p className="text-xs text-muted-foreground">
                  {selectedTemplate
                    ? `${selectedTemplate.name}, ${selectedTemplate.page_w_mm} × ${selectedTemplate.page_h_mm} mm, sample data`
                    : "Choose a template to see a preview."}
                </p>
              </div>
            </CardHeader>
            <CardContent>
              {previewError ? (
                <p className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning">{previewError}</p>
              ) : previewHtml ? (
                <div className="max-h-[60vh] overflow-auto rounded-md border bg-muted p-4">
                  <div className="mx-auto bg-white shadow-md" style={{ width: (selectedTemplate?.page_w_mm ?? 80) * MM_TO_PX, maxWidth: "100%" }}>
                    <iframe
                      srcDoc={previewHtml}
                      sandbox=""
                      className="w-full border-0"
                      style={{ height: (selectedTemplate?.page_h_mm ?? 200) * MM_TO_PX }}
                      title="Print preview"
                    />
                  </div>
                </div>
              ) : (
                <p className="py-10 text-center text-sm text-muted-foreground">No preview yet.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>Batch print</CardTitle>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={refreshBatches}>Refresh</Button>
                <Button variant="outline" size="sm" onClick={() => setShowBatchDialog(true)}>
                  <Play className="h-4 w-4" aria-hidden="true" />
                  New batch
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="max-w-xs space-y-1.5">
                <Label htmlFor="batch-mode">Mode</Label>
                <Select value={store.batchMode2} onValueChange={(v) => store.setBatchMode2(v as "single_job" | "per_record")}>
                  <SelectTrigger id="batch-mode" aria-label="Batch mode"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="single_job">Single job</SelectItem>
                    <SelectItem value="per_record">Per record</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {batches.length === 0 ? (
                <p className="text-sm text-muted-foreground">No batches yet. Start one with a CSV or JSON list.</p>
              ) : (
                <ul className="space-y-2">
                  {(showBatches ? batches : batches.slice(0, 3)).map((b) => {
                    const pct = b.total > 0 ? Math.min(100, Math.round(((b.done + b.failed) / b.total) * 100)) : 0;
                    return (
                      <li key={b.id} className="space-y-1.5 rounded-md border p-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">Batch #{b.id}</span>
                          <JobStatusBadge status={b.status} />
                          <span className="text-xs text-muted-foreground">
                            {b.mode === "per_record" ? "Per record" : "Single job"}, {b.done}/{b.total} done{b.failed > 0 ? `, ${b.failed} failed` : ""}
                          </span>
                          <span className="ml-auto flex gap-1">
                            {(b.status === "queued" || b.status === "printing") && (
                              <Button variant="ghost" size="sm" onClick={() => handleCancelBatch(b.id)}>Cancel</Button>
                            )}
                            {(b.status === "failed" || b.status === "cancelled") && b.failed > 0 && (
                              <Button variant="ghost" size="sm" onClick={() => handleRetryBatch(b.id)}>Retry</Button>
                            )}
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-sm bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Batch ${b.id} progress`}>
                          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {batches.length > 3 && (
                <Button variant="ghost" size="sm" onClick={() => setShowBatches((v) => !v)}>
                  {showBatches ? "Show fewer" : `Show all ${batches.length}`}
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={showBatchDialog} onOpenChange={setShowBatchDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Batch Print</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>CSV Upload (optional)</Label>
              <Input type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleCsvUpload(f); }} />
              {batchCsvFile && <p className="text-xs text-muted-foreground">{batchCsvFile.name} · {batchCsvHeaders.length} columns{batchCsvPreview ? ` · preview ${batchCsvPreview.length} row(s)` : ""}</p>}
              {batchCsvHeaders.length > 0 && (
                <div className="rounded border p-2 text-xs">
                  <p className="font-medium mb-1">Columns → variables: {batchCsvHeaders.join(", ")}</p>
                  <p className="text-muted-foreground">Headers become template keys (e.g. {"{{"}name{"}}" }). Edit JSON below to rename if needed.</p>
                  {batchCsvPreview && (
                    <div className="mt-2 overflow-auto max-h-32">
                      <table className="w-full text-xs">
                        <thead><tr>{batchCsvHeaders.map((h) => <th key={h} className="text-left border-b p-1">{h}</th>)}</tr></thead>
                        <tbody>{batchCsvPreview.map((row, i) => <tr key={i}>{batchCsvHeaders.map((h) => <td key={h} className="p-1 border-b truncate max-w-[120px]">{row[h]}</td>)}</tr>)}</tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="space-y-1">
              <Label>JSON Array</Label>
              <Textarea
                placeholder='[{"name":"Tea","qty":2},{"name":"Coffee","qty":1}]'
                value={batchInput}
                onChange={(e) => setBatchInput(e.target.value)}
                rows={8}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">CSV is auto-converted to this JSON. You can also paste JSON directly.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBatchDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleBatchPrint}>
              <Play className="h-4 w-4" />
              Start Batch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
