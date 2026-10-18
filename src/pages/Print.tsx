import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import { Printer, Eye, Zap, CheckCircle2, XCircle, Play } from "lucide-react";
import { useSystemPrinters } from "@/lib/hooks/useSystemPrinters";
import { toast } from "sonner";
import { usePrintStore } from "@/lib/store/printStore";
import { DEFAULT_MOCK_DATA } from "@/lib/templates/defaultTemplate";
import { ensureStarterTemplates, type TemplateRow } from "@/lib/templates/seedTemplates";
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

  const [showPreview, setShowPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string>("");

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

  const margins = useMemo(
    () =>
      `margin: ${store.marginTop}mm ${store.marginRight}mm ${store.marginBottom}mm ${store.marginLeft}mm;`,
    [
      store.marginTop,
      store.marginRight,
      store.marginBottom,
      store.marginLeft,
    ],
  );

  const buildPreview = async () => {
    const template = selectedTemplate;
    if (!template) {
      toast.error("Select a template to preview");
      return;
    }
    try {
      const versions = await invoke<
        { id: number; html: string; css: string }[]
      >("list_versions", { templateId: template.id });
      const latest = versions?.[0];
      if (!latest) {
        toast.error("Template has no versions yet");
        return;
      }
      const { renderTemplate } = await import("@/lib/render/renderTemplate");
      setPreviewHtml(
        renderTemplate(latest.html, latest.css, DEFAULT_MOCK_DATA as any),
      );
      setShowPreview(true);
    } catch (e) {
      toast.error(`Preview failed: ${e}`);
    }
  };

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">{t("print.title")}</h1>
        <Button variant="outline" size="sm" onClick={loadPrinters}>
          Refresh Printers
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Print Settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t("print.printer")}</Label>
                  <Select value={store.printerId} onValueChange={store.setPrinterId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select printer" />
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
                </div>
                <div className="space-y-2">
                  <Label>{t("print.template")}</Label>
                  <Select value={store.templateId} onValueChange={store.setTemplateId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select template" />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.length === 0 && (
                        <SelectItem value="none" disabled>
                          No templates — create one in Designer
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
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="data-url">{t("print.data_url")}</Label>
                  <div className="flex items-center gap-2">
                    <Label
                      htmlFor="test-data"
                      className="text-xs text-muted-foreground"
                    >
                      Test Data
                    </Label>
                    <Switch
                      id="test-data"
                      checked={store.useTestData}
                      onCheckedChange={store.setUseTestData}
                    />
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
                    Using mock data: {DEFAULT_MOCK_DATA.store.name} — Order #
                    {DEFAULT_MOCK_DATA.order.id}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label>{t("print.orientation")}</Label>
                  <Select
                    value={store.orientation}
                    onValueChange={(v) =>
                      store.setOrientation(v as "portrait" | "landscape")
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="portrait">Portrait</SelectItem>
                      <SelectItem value="landscape">Landscape</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{t("print.fit_mode")}</Label>
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
                    <SelectTrigger>
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
                      <SelectItem value="fill">{t("print.fit_fill")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="copies">{t("print.copies")}</Label>
                  <Input
                    id="copies"
                    type="number"
                    min="1"
                    value={store.copies}
                    onChange={(e) => store.setCopies(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Page Range</Label>
                  <Input
                    placeholder="e.g. 1-5"
                    value={store.pageRange}
                    onChange={(e) => store.setPageRange(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>{t("print.margins")}</Label>
                <div className="grid grid-cols-4 gap-2">
                  <div className="space-y-1">
                    <Label
                      htmlFor="mt"
                      className="text-xs text-muted-foreground"
                    >
                      {t("print.margin_top")}
                    </Label>
                    <Input
                      id="mt"
                      type="number"
                      value={store.marginTop}
                      onChange={(e) => store.setMarginTop(Number(e.target.value))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label
                      htmlFor="mr"
                      className="text-xs text-muted-foreground"
                    >
                      {t("print.margin_right")}
                    </Label>
                    <Input
                      id="mr"
                      type="number"
                      value={store.marginRight}
                      onChange={(e) =>
                        store.setMarginRight(Number(e.target.value))
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label
                      htmlFor="mb"
                      className="text-xs text-muted-foreground"
                    >
                      {t("print.margin_bottom")}
                    </Label>
                    <Input
                      id="mb"
                      type="number"
                      value={store.marginBottom}
                      onChange={(e) =>
                        store.setMarginBottom(Number(e.target.value))
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label
                      htmlFor="ml"
                      className="text-xs text-muted-foreground"
                    >
                      {t("print.margin_left")}
                    </Label>
                    <Input
                      id="ml"
                      type="number"
                      value={store.marginLeft}
                      onChange={(e) =>
                        store.setMarginLeft(Number(e.target.value))
                      }
                    />
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Switch
                  id="grayscale"
                  checked={store.grayscale}
                  onCheckedChange={store.setGrayscale}
                />
                <Label htmlFor="grayscale">Grayscale</Label>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Batch Print</CardTitle>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={refreshBatches}>Refresh</Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowBatchDialog(true)}
                  >
                    <Play className="h-4 w-4" />
                    New Batch
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Mode</Label>
                  <Select
                    value={store.batchMode2}
                    onValueChange={(v) =>
                      store.setBatchMode2(v as "single_job" | "per_record")
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="single_job">Single Job</SelectItem>
                      <SelectItem value="per_record">Per Record</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Status</Label>
                  {batches.length === 0 ? (
                    <Badge variant="secondary">No batches yet</Badge>
                  ) : (
                    <Badge variant={batches[0].status === "queued" || batches[0].status === "printing" ? "default" : batches[0].status === "success" ? "secondary" : "destructive"}>
                      #{batches[0].id} {batches[0].status} {batches[0].done}/{batches[0].total}
                    </Badge>
                  )}
                </div>
              </div>
              {batches.length > 0 && (
                <div className="space-y-2 max-h-48 overflow-auto">
                  {batches.slice(0, 5).map((b) => (
                    <div key={b.id} className="flex items-center justify-between rounded border p-2 text-xs">
                      <div>
                        <span className="font-medium">#{b.id}</span> {b.mode} · {b.status} · {b.done}/{b.total} done{b.failed > 0 ? `, ${b.failed} failed` : ""}
                      </div>
                      <div className="flex gap-1">
                        {(b.status === "queued" || b.status === "printing") && (
                          <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => handleCancelBatch(b.id)}>Cancel</Button>
                        )}
                        {(b.status === "failed" || b.status === "cancelled") && b.failed > 0 && (
                          <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => handleRetryBatch(b.id)}>Retry</Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {batches.length > 0 && batches[0].total > 0 && (
                <div className="h-2 w-full rounded bg-muted overflow-hidden">
                  <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, Math.round(((batches[0].done + batches[0].failed) / batches[0].total) * 100))}%` }} />
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex gap-3">
            <Button
              size="lg"
              className="flex-1"
              onClick={handlePrint}
              disabled={store.status === "printing" || loading}
            >
              <Printer className="h-5 w-5" />
              {t("print.print")}
            </Button>
            <Button size="lg" variant="outline" onClick={buildPreview}>
              <Eye className="h-5 w-5" />
              {t("print.preview")}
            </Button>
          </div>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("print.live_status")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {store.status === "success" && (
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                  <div>
                    <p className="text-sm font-medium text-green-700 dark:text-green-400">
                      Print successful
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Duration: {store.durationMs}ms
                    </p>
                  </div>
                </div>
              )}
              {store.status === "failed" && (
                <div className="flex items-center gap-3">
                  <XCircle className="h-5 w-5 text-red-600" />
                  <div>
                    <p className="text-sm font-medium text-red-700 dark:text-red-400">
                      Print failed
                    </p>
                    <p className="text-xs text-muted-foreground">{store.error}</p>
                  </div>
                </div>
              )}
              {store.status === "printing" && (
                <div className="flex items-center gap-3">
                  <div className="h-5 w-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm">Printing…</p>
                </div>
              )}
              {store.status === "idle" && (
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{t("print.queued")}</Badge>
                  <span className="text-sm text-muted-foreground">
                    Waiting to print…
                  </span>
                </div>
              )}

              <div className="pt-3 border-t text-xs text-muted-foreground space-y-1">
                <p>Template: {selectedTemplate?.name ?? "—"}</p>
                <p>
                  Page: {selectedTemplate ? `${selectedTemplate.page_w_mm} × ${selectedTemplate.page_h_mm} mm` : "—"}
                </p>
                <p>CSS: {margins}</p>
              </div>
            </CardContent>
          </Card>

          <Card className="border-2 border-dashed border-cyan-500/50 bg-cyan-50/50 dark:bg-cyan-950/20">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <Zap className="h-5 w-5 text-cyan-600 dark:text-cyan-400" />
                <CardTitle className="text-base text-cyan-800 dark:text-cyan-200">
                  Pipeline Test
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <Button
                onClick={handleSpikeTest}
                disabled={store.status === "printing"}
                className="bg-cyan-600 hover:bg-cyan-700 w-full"
              >
                <Zap className="h-4 w-4" />
                Send Test Page
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              Preview — {selectedTemplate?.name} ({selectedTemplate?.page_w_mm}×
              {selectedTemplate?.page_h_mm}mm)
            </DialogTitle>
          </DialogHeader>
          <div className="border rounded-md overflow-auto bg-gray-100 dark:bg-gray-900 p-4 max-h-[70vh]">
            <div
              className="mx-auto bg-white shadow"
              style={{
                width: (selectedTemplate?.page_w_mm ?? 80) * MM_TO_PX,
              }}
            >
              <iframe
                srcDoc={previewHtml}
                className="w-full border-0"
                style={{
                  height: (selectedTemplate?.page_h_mm ?? 200) * MM_TO_PX,
                }}
                title="Print preview"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPreview(false)}>
              Close
            </Button>
            <Button
              onClick={() => {
                setShowPreview(false);
                handlePrint();
              }}
            >
              Print
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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