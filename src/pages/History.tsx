import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RotateCcw, Download, Search, Trash2, Eye } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useHistoryStore, type HistoryJob } from "@/lib/store/historyStore";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

const STATUS_VARIANTS: Record<string, "success" | "destructive" | "secondary" | "warning"> = {
  success: "success",
  failed: "destructive",
  queued: "secondary",
  printing: "warning",
  cancelled: "secondary",
};

export function HistoryPage() {
  const { t } = useTranslation();
  const store = useHistoryStore();
  const [loading, setLoading] = useState(true);

  // Fetch jobs on mount (was never called -> history was always empty).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const jobs = await invoke<HistoryJob[]>("list_jobs");
        if (!cancelled) store.setJobs(jobs ?? []);
      } catch (e) {
        if (!cancelled) toast.error(`Failed to load history: ${e}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredJobs = store.jobs.filter((job) => {
    if (store.filter.status !== "all" && job.status !== store.filter.status) return false;
    if (store.filter.printer !== "all" && job.printer_id?.toString() !== store.filter.printer) return false;
    if (store.filter.source !== "all" && job.source !== store.filter.source) return false;
    if (store.filter.isTest !== null && job.is_test !== store.filter.isTest) return false;
    if (store.filter.dateFrom) {
      const from = new Date(store.filter.dateFrom);
      const ts = job.finished_at || job.started_at;
      if (ts && new Date(ts) < from) return false;
    }
    if (store.filter.dateTo) {
      const to = new Date(store.filter.dateTo);
      to.setHours(23, 59, 59, 999);
      const ts = job.finished_at || job.started_at;
      if (ts && new Date(ts) > to) return false;
    }
    if (store.filter.search) {
      const q = store.filter.search.toLowerCase();
      const match = job.source_url?.toLowerCase().includes(q) ||
        job.error?.toLowerCase().includes(q) ||
        job.id.toString().includes(q);
      if (!match) return false;
    }
    return true;
  });

  // Batch grouping (PLANNING §8): jobs with the same batch_id are collapsible
  const [expandedBatches, setExpandedBatches] = useState<Set<number>>(new Set());
  const toggleBatch = (id: number) => {
    setExpandedBatches((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const grouped = (() => {
    const batches = new Map<number, HistoryJob[]>();
    const singles: HistoryJob[] = [];
    for (const j of filteredJobs) {
      if (j.batch_id != null) {
        const arr = batches.get(j.batch_id) ?? [];
        arr.push(j);
        batches.set(j.batch_id, arr);
      } else singles.push(j);
    }
    return { batches, singles };
  })();

  const handleReprint = async (job: HistoryJob) => {
    try {
      const copy = await invoke<HistoryJob>("reprint_job", { id: job.id });
      store.setJobs([copy, ...store.jobs]);
      toast.success(`Queued reprint of job #${job.id}`);
    } catch (e) {
      toast.error(`Reprint failed: ${e}`);
    }
  };

  const handleRetry = async (job: HistoryJob) => {
    try {
      const updated = await invoke<HistoryJob>("retry_job", { id: job.id });
      store.setJobs(
        store.jobs.map((j) => (j.id === updated.id ? updated : j)),
      );
      toast.success(`Job #${job.id} re-queued`);
    } catch (e) {
      toast.error(`Retry failed: ${e}`);
    }
  };

  const handleDelete = async (job: HistoryJob) => {
    try {
      await invoke("delete_job", { id: job.id });
      store.setJobs(store.jobs.filter((j) => j.id !== job.id));
      toast.success(`Deleted job #${job.id}`);
    } catch (e) {
      toast.error(`Failed: ${e}`);
    }
  };

  const handleExportCsv = () => {
    if (filteredJobs.length === 0) {
      toast.error("Nothing to export");
      return;
    }

    // RFC 4180 escaping: wrap in quotes and double any embedded quotes.
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const headers = [
      "ID",
      "Status",
      "Source",
      "Printer",
      "Duration",
      "Error",
    ];
    const rows = filteredJobs.map((j) =>
      [j.id, j.status, j.source, j.printer_id, j.duration_ms, j.error]
        .map(esc)
        .join(","),
    );

    const csv = [headers.join(","), ...rows].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "printninja-history.csv";
    a.click();
    // Release the object URL, otherwise the blob is retained in memory.
    URL.revokeObjectURL(url);
    toast.success(`Exported ${filteredJobs.length} job(s)`);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">{t("history.title")}</h1>
        <Button variant="outline" size="sm" onClick={handleExportCsv}>
          <Download className="h-4 w-4" />
          {t("history.export_csv")}
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap gap-2 sm:gap-3">
            <div className="relative w-full sm:flex-1 sm:min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t("common.search")}
                className="pl-9"
                value={store.filter.search}
                onChange={(e) => store.setFilter({ search: e.target.value })}
              />
            </div>
            <Select value={store.filter.status} onValueChange={(v) => store.setFilter({ status: v })}>
              <SelectTrigger className="w-full sm:w-[140px]">
                <SelectValue placeholder={t("history.filter_status")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("common.all")}</SelectItem>
                <SelectItem value="success">{t("history.success")}</SelectItem>
                <SelectItem value="failed">{t("history.failed")}</SelectItem>
                <SelectItem value="queued">{t("history.queued")}</SelectItem>
                <SelectItem value="printing">{t("history.printing")}</SelectItem>
                <SelectItem value="cancelled">{t("history.cancelled")}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={store.filter.source} onValueChange={(v) => store.setFilter({ source: v })}>
              <SelectTrigger className="w-full sm:w-[140px]">
                <SelectValue placeholder={t("history.source")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("common.all")}</SelectItem>
                <SelectItem value="ui">UI</SelectItem>
                <SelectItem value="api">API</SelectItem>
                <SelectItem value="deeplink">Deep Link</SelectItem>
                <SelectItem value="batch">Batch</SelectItem>
                <SelectItem value="test">Test</SelectItem>
              </SelectContent>
            </Select>
            <Select value={store.filter.printer} onValueChange={(v) => store.setFilter({ printer: v })}>
              <SelectTrigger className="w-full sm:w-[160px]">
                <SelectValue placeholder={t("history.filter_printer")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("common.all")}</SelectItem>
                <SelectItem value="1">Front Desk</SelectItem>
                <SelectItem value="2">Kitchen</SelectItem>
                <SelectItem value="3">Label Printer 1</SelectItem>
              </SelectContent>
            </Select>
            <Input type="date" className="w-full sm:w-[150px]" value={store.filter.dateFrom} onChange={(e) => store.setFilter({ dateFrom: e.target.value })} placeholder="From" />
            <Input type="date" className="w-full sm:w-[150px]" value={store.filter.dateTo} onChange={(e) => store.setFilter({ dateTo: e.target.value })} placeholder="To" />
            <Button variant="ghost" size="sm" onClick={store.clearFilter} className="w-full sm:w-auto">
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* History — desktop table, mobile cards */}
      <Card className="hidden md:block">
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Time</TableHead>
                <TableHead className="hidden lg:table-cell">Template</TableHead>
                <TableHead>Printer</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden xl:table-cell">Duration</TableHead>
                <TableHead className="hidden lg:table-cell">Source</TableHead>
                <TableHead className="hidden xl:table-cell">Version</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="text-center py-12 text-muted-foreground"
                  >
                    Loading history…
                  </TableCell>
                </TableRow>
              ) : filteredJobs.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="text-center py-12 text-muted-foreground"
                  >
                    No print jobs yet. Print something to see it here.
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {Array.from(grouped.batches.entries()).map(([batchId, jobs]) => (
                    <>
                      <TableRow key={`batch-${batchId}`} className="bg-muted/50">
                        <TableCell colSpan={5} className="font-medium">
                          <button type="button" onClick={() => toggleBatch(batchId)} className="flex items-center gap-2">
                            <span>{expandedBatches.has(batchId) ? "▼" : "▶"}</span> Batch #{batchId} · {jobs.length} job(s) · {jobs.filter((j) => j.status === "success").length} ok, {jobs.filter((j) => j.status === "failed").length} failed
                          </button>
                        </TableCell>
                        <TableCell colSpan={4} className="text-right text-xs text-muted-foreground hidden lg:table-cell">
                          {jobs[0]?.finished_at || jobs[0]?.started_at || ""}
                        </TableCell>
                      </TableRow>
                      {expandedBatches.has(batchId) && jobs.map((job) => (
                        <TableRow key={job.id} className="bg-muted/20">
                          <TableCell className="text-muted-foreground pl-6">#{job.id}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {job.finished_at || job.started_at || "—"}
                          </TableCell>
                          <TableCell className="font-medium hidden lg:table-cell">
                            {job.template_id ? `Template ${job.template_id}` : "—"}
                          </TableCell>
                          <TableCell>{job.printer_id ? `Printer ${job.printer_id}` : "—"}</TableCell>
                          <TableCell>
                            <Badge variant={STATUS_VARIANTS[job.status] || "secondary"}>
                              {job.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="hidden xl:table-cell">{job.duration_ms ? `${job.duration_ms}ms` : "—"}</TableCell>
                          <TableCell className="hidden lg:table-cell">
                            <Badge variant="outline">{job.source}</Badge>
                          </TableCell>
                          <TableCell className="hidden xl:table-cell">
                            {job.template_version_id ? `v${job.template_version_id}` : "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button variant="ghost" size="sm" onClick={() => store.setSelectedJob(job)}>
                                <Eye className="h-3 w-3" />
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => handleReprint(job)}>
                                <RotateCcw className="h-3 w-3" />
                              </Button>
                              {job.status === "failed" && (
                                <Button variant="ghost" size="sm" onClick={() => handleRetry(job)}>
                                  <RotateCcw className="h-3 w-3" />
                                </Button>
                              )}
                              <Button variant="ghost" size="sm" onClick={() => handleDelete(job)}>
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </>
                  ))}
                  {grouped.singles.map((job) => (
                    <TableRow key={job.id}>
                      <TableCell className="text-muted-foreground">#{job.id}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {job.finished_at || job.started_at || "—"}
                      </TableCell>
                      <TableCell className="font-medium hidden lg:table-cell">
                        {job.template_id ? `Template ${job.template_id}` : "—"}
                      </TableCell>
                      <TableCell>{job.printer_id ? `Printer ${job.printer_id}` : "—"}</TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANTS[job.status] || "secondary"}>
                          {job.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden xl:table-cell">{job.duration_ms ? `${job.duration_ms}ms` : "—"}</TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <Badge variant="outline">{job.source}</Badge>
                      </TableCell>
                      <TableCell className="hidden xl:table-cell">
                        {job.template_version_id ? `v${job.template_version_id}` : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => store.setSelectedJob(job)}>
                            <Eye className="h-3 w-3" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => handleReprint(job)}>
                            <RotateCcw className="h-3 w-3" />
                          </Button>
                          {job.status === "failed" && (
                            <Button variant="ghost" size="sm" onClick={() => handleRetry(job)}>
                              <RotateCcw className="h-3 w-3" />
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" onClick={() => handleDelete(job)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        {loading ? (
          <Card><CardContent className="py-8 text-center text-muted-foreground text-sm">Loading history…</CardContent></Card>
        ) : filteredJobs.length === 0 ? (
          <Card><CardContent className="py-8 text-center text-muted-foreground text-sm">No print jobs yet. Print something to see it here.</CardContent></Card>
        ) : (
          <>
            {Array.from(grouped.batches.entries()).map(([batchId, jobs]) => (
              <Card key={`m-batch-${batchId}`} className="overflow-hidden">
                <div className="bg-muted/50 px-3 py-2 flex items-center justify-between">
                  <button type="button" onClick={() => toggleBatch(batchId)} className="flex items-center gap-2 text-sm font-medium">
                    <span>{expandedBatches.has(batchId) ? "▼" : "▶"}</span> Batch #{batchId}
                  </button>
                  <span className="text-xs text-muted-foreground">{jobs.length} jobs · {jobs.filter(j=>j.status==="success").length} ok</span>
                </div>
                {expandedBatches.has(batchId) && (
                  <div className="divide-y">
                    {jobs.map((job) => (
                      <div key={job.id} className="p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium">#{job.id}</span>
                          <Badge variant={STATUS_VARIANTS[job.status] || "secondary"}>{job.status}</Badge>
                        </div>
                        <div className="text-xs text-muted-foreground">{job.finished_at || job.started_at || "—"} · {job.printer_id ? `Printer ${job.printer_id}` : "—"}</div>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="sm" className="flex-1" onClick={() => store.setSelectedJob(job)}><Eye className="h-3 w-3" /> View</Button>
                          <Button variant="ghost" size="sm" className="flex-1" onClick={() => handleReprint(job)}><RotateCcw className="h-3 w-3" /> Reprint</Button>
                          <Button variant="ghost" size="sm" onClick={() => handleDelete(job)}><Trash2 className="h-3 w-3" /></Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            ))}
            {grouped.singles.map((job) => (
              <Card key={`m-${job.id}`}>
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">#{job.id}</span>
                    <Badge variant={STATUS_VARIANTS[job.status] || "secondary"}>{job.status}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground space-y-1">
                    <div>{job.finished_at || job.started_at || "—"}</div>
                    <div>{job.printer_id ? `Printer ${job.printer_id}` : "—"} {job.template_id ? `· Template ${job.template_id}` : ""}</div>
                    {job.error && <div className="text-destructive truncate">{job.error}</div>}
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" className="flex-1" onClick={() => store.setSelectedJob(job)}><Eye className="h-3 w-3" /> View</Button>
                    <Button variant="ghost" size="sm" className="flex-1" onClick={() => handleReprint(job)}><RotateCcw className="h-3 w-3" /> Reprint</Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(job)}><Trash2 className="h-3 w-3" /></Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </>
        )}
      </div>

      {/* Job Detail Dialog */}
      <Dialog open={!!store.selectedJob} onOpenChange={() => store.setSelectedJob(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Job #{store.selectedJob?.id}</DialogTitle>
          </DialogHeader>
          {store.selectedJob && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs text-muted-foreground">Status</Label>
                  <Badge variant={STATUS_VARIANTS[store.selectedJob.status]}>
                    {store.selectedJob.status}
                  </Badge>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Source</Label>
                  <Badge variant="outline">{store.selectedJob.source}</Badge>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Printer</Label>
                  <p className="text-sm">{store.selectedJob.printer_id || "—"}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Duration</Label>
                  <p className="text-sm">{store.selectedJob.duration_ms ? `${store.selectedJob.duration_ms}ms` : "—"}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Template Version</Label>
                  <p className="text-sm">{store.selectedJob.template_version_id ? `v${store.selectedJob.template_version_id}` : "—"}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Copies</Label>
                  <p className="text-sm">{store.selectedJob.copies}</p>
                </div>
              </div>
              {store.selectedJob.error && (
                <div>
                  <Label className="text-xs text-muted-foreground">Error</Label>
                  <p className="text-sm text-red-600 dark:text-red-400">{store.selectedJob.error}</p>
                </div>
              )}
              {store.selectedJob.source_url && (
                <div>
                  <Label className="text-xs text-muted-foreground">Source URL</Label>
                  <p className="text-sm font-mono break-all">{store.selectedJob.source_url}</p>
                </div>
              )}
              {store.selectedJob.settings_json && (
                <div>
                  <Label className="text-xs text-muted-foreground">
                    Settings
                  </Label>
                  <pre className="text-xs bg-muted p-2 rounded-md overflow-auto max-h-40">
                    {(() => {
                      try {
                        return JSON.stringify(
                          JSON.parse(store.selectedJob!.settings_json!),
                          null,
                          2,
                        );
                      } catch {
                        // Malformed JSON must not crash the dialog.
                        return store.selectedJob!.settings_json;
                      }
                    })()}
                  </pre>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
