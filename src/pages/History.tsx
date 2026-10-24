import { Fragment, useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Bookmark,
  Download,
  Eye,
  MoreHorizontal,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { agent } from "@/lib/agent/commands";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DataTable } from "@/components/DataTable";
import { PageHeader } from "@/components/PageHeader";
import { JobStatusBadge } from "@/components/StatusBadge";
import { TimingBreakdown } from "@/components/TimingBreakdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useHistoryStore,
  type HistoryFilter,
  type HistoryJob,
} from "@/lib/store/historyStore";
import { parseTimings } from "@/lib/timings";
import { PHONE_QUERY, useMediaQuery } from "@/lib/hooks/useMediaQuery";
import { Sheet, SheetContent } from "@/components/ui/sheet";

interface PrinterOption {
  id: number;
  name: string;
}
interface SavedFilter {
  name: string;
  filter: HistoryFilter;
}

const SAVED_KEY = "printninja-history-filters";
const loadSaved = (): SavedFilter[] => {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) ?? "[]") as SavedFilter[];
  } catch {
    return [];
  }
};
const persistSaved = (list: SavedFilter[]) => {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list));
  } catch {}
};

const fmtTime = (job: HistoryJob) => {
  const raw = job.finished_at || job.started_at;
  if (!raw) return "—";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleString();
};

export function HistoryPage() {
  const { t } = useTranslation();
  const store = useHistoryStore();
  const [loading, setLoading] = useState(true);
  const [printers, setPrinters] = useState<PrinterOption[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<SavedFilter[]>(loadSaved);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [confirm, setConfirm] = useState<
    | { kind: "bulk-reprint" }
    | { kind: "bulk-retry" }
    | { kind: "reprint"; job: HistoryJob }
    | { kind: "retry"; job: HistoryJob }
    | { kind: "delete"; job: HistoryJob }
    | null
  >(null);
  const [busy, setBusy] = useState(false);
  // Phone: the six filter controls live in a bottom sheet, opened here.
  // (md and up keeps them inline; jsdom reports no phone, so tests see that.)
  const [filtersOpen, setFiltersOpen] = useState(false);
  const isPhone = useMediaQuery(PHONE_QUERY);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const jobs = await agent("list_jobs", {});
        if (!cancelled) store.setJobs(jobs ?? []);
      } catch (e) {
        if (!cancelled) toast.error(`Failed to load history: ${e}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
      try {
        const list = await agent("list_printers", {});
        if (!cancelled) setPrinters(list ?? []);
      } catch {
        /* printer names are optional here */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const printerName = (id: number | null) =>
    id == null
      ? "—"
      : (printers.find((p) => p.id === id)?.name ?? `Printer #${id}`);

  const filteredJobs = useMemo(
    () =>
      store.jobs.filter((job) => {
        const f = store.filter;
        if (f.status !== "all" && job.status !== f.status) return false;
        if (f.printer !== "all" && job.printer_id?.toString() !== f.printer)
          return false;
        if (f.source !== "all" && job.source !== f.source) return false;
        if (f.isTest !== null && job.is_test !== f.isTest) return false;
        const ts = job.finished_at || job.started_at;
        if (f.dateFrom && ts && new Date(ts) < new Date(f.dateFrom))
          return false;
        if (f.dateTo) {
          const to = new Date(f.dateTo);
          to.setHours(23, 59, 59, 999);
          if (ts && new Date(ts) > to) return false;
        }
        if (f.search) {
          const q = f.search.toLowerCase();
          const match =
            job.source_url?.toLowerCase().includes(q) ||
            job.error?.toLowerCase().includes(q) ||
            job.id.toString().includes(q) ||
            (job.batch_id != null && `batch ${job.batch_id}`.includes(q)) ||
            printerName(job.printer_id).toLowerCase().includes(q) ||
            (job.template_id != null &&
              `template ${job.template_id}`.includes(q));
          if (!match) return false;
        }
        return true;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store.jobs, store.filter, printers],
  );

  const selectedJobs = filteredJobs.filter((j) => selected.has(String(j.id)));
  const selectedFailed = selectedJobs.filter((j) => j.status === "failed");

  const reprintOne = async (job: HistoryJob) => {
    const copy = await agent("reprint_job", { id: job.id });
    useHistoryStore
      .getState()
      .setJobs([copy, ...useHistoryStore.getState().jobs]);
    return copy;
  };
  const retryOne = async (job: HistoryJob) => {
    const updated = await agent("retry_job", { id: job.id });
    const cur = useHistoryStore.getState();
    cur.setJobs(cur.jobs.map((j) => (j.id === updated.id ? updated : j)));
  };

  const handleReprint = async (job: HistoryJob) => {
    try {
      await reprintOne(job);
      toast.success(`Queued reprint of job #${job.id}`);
    } catch (e) {
      toast.error(`Reprint failed: ${e}`);
    } finally {
      setConfirm(null);
    }
  };
  const handleRetry = async (job: HistoryJob) => {
    try {
      await retryOne(job);
      toast.success(`Job #${job.id} re-queued`);
    } catch (e) {
      toast.error(`Retry failed: ${e}`);
    } finally {
      setConfirm(null);
    }
  };

  const runBulk = async (
    fn: (j: HistoryJob) => Promise<unknown>,
    jobs: HistoryJob[],
    verb: string,
  ) => {
    setBusy(true);
    let ok = 0;
    const failures: number[] = [];
    for (const job of jobs) {
      try {
        await fn(job);
        ok++;
      } catch {
        failures.push(job.id);
      }
    }
    setBusy(false);
    setConfirm(null);
    if (failures.length === 0) toast.success(`${verb} ${ok} job(s)`);
    else
      toast.error(
        `${verb} ${ok} job(s). Failed for ${failures.map((i) => `#${i}`).join(", ")}.`,
      );
    setSelected(new Set());
  };

  const confirmDelete = async (job: HistoryJob) => {
    setBusy(true);
    try {
      await agent("delete_job", { id: job.id });
      const cur = useHistoryStore.getState();
      cur.setJobs(cur.jobs.filter((j) => j.id !== job.id));
      setSelected((s) => {
        const n = new Set(s);
        n.delete(String(job.id));
        return n;
      });
      toast.success(`Deleted job #${job.id}`);
      setConfirm(null);
    } catch (e) {
      toast.error(`Could not delete job #${job.id}: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const handleExportCsv = () => {
    if (filteredJobs.length === 0) {
      toast.error("Nothing to export");
      return;
    }
    // Full-row export: everything the details dialog shows, with the
    // printer name instead of a bare id. RFC 4180 escaping throughout.
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const fmtTimings = (timingsJson: string | null) => {
      if (!timingsJson) return "";
      try {
        const t = JSON.parse(timingsJson) as Record<string, unknown>;
        return (
          [
            "fetch",
            "template",
            "layout",
            "render",
            "send",
            "history",
            "total",
          ] as const
        )
          .map((k) => `${k}=${t[`${k}_ms`] ?? 0}ms`)
          .join(" ");
      } catch {
        return timingsJson;
      }
    };
    const headers = [
      "ID",
      "Status",
      "Source",
      "Printer",
      "Template",
      "Batch",
      "Copies",
      "Test",
      "Started",
      "Finished",
      "DurationMs",
      "Timings",
      "Error",
    ];
    const rows = filteredJobs.map((j) =>
      [
        j.id,
        j.status,
        j.source,
        printerName(j.printer_id),
        j.template_id,
        j.batch_id,
        j.copies,
        j.is_test ? "yes" : "no",
        j.started_at,
        j.finished_at,
        j.duration_ms,
        fmtTimings(j.timings_json),
        j.error,
      ]
        .map(esc)
        .join(","),
    );
    const csv = [headers.join(","), ...rows].join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "printninja-history.csv";
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${filteredJobs.length} job(s)`);
  };

  const saveCurrentFilter = () => {
    const name = saveName.trim();
    if (!name) return;
    const next = [
      ...saved.filter((s) => s.name !== name),
      { name, filter: { ...store.filter } },
    ];
    setSaved(next);
    persistSaved(next);
    setSaveOpen(false);
    setSaveName("");
    toast.success(`Saved filter "${name}"`);
  };
  const removeSaved = (name: string) => {
    const next = saved.filter((s) => s.name !== name);
    setSaved(next);
    persistSaved(next);
  };

  const columns = useMemo<ColumnDef<HistoryJob>[]>(
    () => [
      {
        id: "id",
        header: "Job",
        accessorFn: (j) => j.id,
        enableSorting: true,
        cell: (c) => (
          <div>
            <span className="font-mono text-xs">#{c.row.original.id}</span>
            {/* Phones drop the Printer column; show it under the job number instead. */}
            <p className="max-w-[4.25rem] truncate text-xs text-muted-foreground sm:hidden">
              {printerName(c.row.original.printer_id)}
            </p>
          </div>
        ),
      },
      {
        id: "time",
        header: "Time",
        accessorFn: (j) => j.finished_at || j.started_at || "",
        enableSorting: true,
        meta: { className: "hidden md:table-cell" },
        cell: (c) => (
          <span className="text-muted-foreground">
            {fmtTime(c.row.original)}
          </span>
        ),
      },
      {
        id: "template",
        header: "Template",
        meta: { className: "hidden lg:table-cell" },
        cell: (c) =>
          c.row.original.template_id != null
            ? `Template #${c.row.original.template_id}`
            : "—",
      },
      {
        id: "printer",
        header: "Printer",
        meta: { className: "hidden sm:table-cell" },
        cell: (c) => printerName(c.row.original.printer_id),
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (j) => j.status,
        enableSorting: true,
        cell: (c) => <JobStatusBadge status={c.row.original.status} />,
      },
      {
        id: "duration",
        header: "Duration",
        meta: { className: "hidden lg:table-cell" },
        cell: (c) => {
          const j = c.row.original;
          if (j.duration_ms == null) return "—";
          const tm = parseTimings(j.timings_json);
          return (
            <div>
              <span className="tabular-nums">{j.duration_ms} ms</span>
              {/* Where the time went; older jobs have no breakdown. */}
              {tm && (
                <p
                  className="text-xs tabular-nums text-muted-foreground"
                  title={`Render ${tm.render_ms} ms, send ${tm.send_ms} ms, history write ${tm.history_ms} ms`}
                >
                  Render {tm.render_ms} · Send {tm.send_ms} · History{" "}
                  {tm.history_ms}
                </p>
              )}
            </div>
          );
        },
      },
      {
        id: "source",
        header: "Source",
        meta: { className: "hidden lg:table-cell" },
        cell: (c) => <Badge variant="outline">{c.row.original.source}</Badge>,
      },
      {
        id: "batch",
        header: "Batch",
        meta: { className: "hidden xl:table-cell" },
        cell: (c) =>
          c.row.original.batch_id != null ? `#${c.row.original.batch_id}` : "—",
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        meta: { className: "text-right" },
        cell: (c) => {
          const job = c.row.original;
          return (
            <div
              className="flex flex-wrap justify-end gap-1"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {/* On phones tapping the row opens the same details, so this button is hidden there. */}
              <Button
                variant="ghost"
                size="icon"
                className="hidden sm:inline-flex"
                aria-label={`View job ${job.id}`}
                title="View details"
                onClick={() => store.setSelectedJob(job)}
              >
                <Eye className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Reprint job ${job.id}`}
                title={t("history.reprint")}
                onClick={() => setConfirm({ kind: "reprint", job })}
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
              {job.status === "failed" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirm({ kind: "retry", job })}
                >
                  {t("history.retry")}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete job ${job.id}`}
                title="Delete"
                onClick={() => setConfirm({ kind: "delete", job })}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          );
        },
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
    ],
    [printers, t],
  );

  const f = store.filter;
  // Filters hidden behind the phone toggle (everything except Search), for its badge count.
  const moreFiltersActive = [
    f.status !== "all",
    f.printer !== "all",
    f.source !== "all",
    f.isTest !== null,
    !!f.dateFrom,
    !!f.dateTo,
  ].filter(Boolean).length;
  const filtersActive =
    f.status !== "all" ||
    f.printer !== "all" ||
    f.source !== "all" ||
    f.isTest !== null ||
    !!f.dateFrom ||
    !!f.dateTo ||
    !!f.search;
  const job = store.selectedJob;

  // The six filter controls, shared by the inline bar (md and up) and the
  // phone bottom sheet. `labeled` adds a visible label above each control;
  // the inline bar stays compact and relies on aria-labels. The Saved-filters
  // menu stays inline-only: it is a desktop workflow.
  const filterFields = (labeled: boolean) => {
    const wrap = (id: string, label: string, control: React.ReactNode) =>
      labeled ? (
        <div key={id} className="space-y-1.5">
          <Label htmlFor={id}>{label}</Label>
          {control}
        </div>
      ) : (
        <Fragment key={id}>{control}</Fragment>
      );
    return [
      wrap(
        "history-filter-status",
        t("common.status"),
        <Select
          value={f.status}
          onValueChange={(v) => store.setFilter({ status: v })}
        >
          <SelectTrigger
            id="history-filter-status"
            aria-label="Filter by status"
            className="w-full sm:w-[140px]"
          >
            <SelectValue placeholder={t("history.filter_status")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("common.all")}</SelectItem>
            <SelectItem value="success">{t("status.success")}</SelectItem>
            <SelectItem value="failed">{t("status.failed")}</SelectItem>
            <SelectItem value="queued">{t("status.queued")}</SelectItem>
            <SelectItem value="printing">{t("status.printing")}</SelectItem>
            <SelectItem value="cancelled">{t("status.cancelled")}</SelectItem>
          </SelectContent>
        </Select>,
      ),
      wrap(
        "history-filter-source",
        t("history.filter_source"),
        <Select
          value={f.source}
          onValueChange={(v) => store.setFilter({ source: v })}
        >
          <SelectTrigger
            id="history-filter-source"
            aria-label="Filter by source"
            className="w-full sm:w-[130px]"
          >
            <SelectValue placeholder={t("history.source")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("common.all")}</SelectItem>
            <SelectItem value="ui">UI</SelectItem>
            <SelectItem value="api">API</SelectItem>
            <SelectItem value="deeplink">Deep link</SelectItem>
            <SelectItem value="batch">Batch</SelectItem>
            <SelectItem value="test">Test</SelectItem>
          </SelectContent>
        </Select>,
      ),
      wrap(
        "history-filter-test",
        t("history.filter_test"),
        <Select
          value={f.isTest === null ? "all" : f.isTest ? "yes" : "no"}
          onValueChange={(v) =>
            store.setFilter({
              isTest: v === "all" ? null : v === "yes",
            })
          }
        >
          <SelectTrigger
            id="history-filter-test"
            aria-label="Filter test jobs"
            className="w-full sm:w-[130px]"
          >
            <SelectValue placeholder={t("history.filter_test")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All jobs</SelectItem>
            <SelectItem value="yes">{t("history.test_only")}</SelectItem>
            <SelectItem value="no">{t("history.hide_test")}</SelectItem>
          </SelectContent>
        </Select>,
      ),
      wrap(
        "history-filter-printer",
        t("print.printer"),
        <Select
          value={f.printer}
          onValueChange={(v) => store.setFilter({ printer: v })}
        >
          <SelectTrigger
            id="history-filter-printer"
            aria-label="Filter by printer"
            className="w-full sm:w-[160px]"
          >
            <SelectValue placeholder={t("history.filter_printer")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("common.all")}</SelectItem>
            {[
              ...new Set(
                store.jobs
                  .map((j) => j.printer_id)
                  .filter((x): x is number => x != null),
              ),
            ]
              .sort((a, b) => a - b)
              .map((id) => (
                <SelectItem key={id} value={String(id)}>
                  {printerName(id)}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>,
      ),
      wrap(
        "history-filter-from",
        t("history.filter_from"),
        <Input
          id="history-filter-from"
          type="date"
          aria-label="From date"
          className="w-full sm:w-[150px]"
          value={f.dateFrom}
          onChange={(e) => store.setFilter({ dateFrom: e.target.value })}
        />,
      ),
      wrap(
        "history-filter-to",
        t("history.filter_to"),
        <Input
          id="history-filter-to"
          type="date"
          aria-label="To date"
          className="w-full sm:w-[150px]"
          value={f.dateTo}
          onChange={(e) => store.setFilter({ dateTo: e.target.value })}
        />,
      ),
    ];
  };

  // One removable chip per active non-search filter, under the search box.
  const activeChips: Array<{
    key: string;
    label: string;
    clear: () => void;
  }> = [];
  if (f.status !== "all")
    activeChips.push({
      key: "status",
      label: t(`status.${f.status}`, { defaultValue: f.status }),
      clear: () => store.setFilter({ status: "all" }),
    });
  if (f.source !== "all")
    activeChips.push({
      key: "source",
      label: f.source,
      clear: () => store.setFilter({ source: "all" }),
    });
  if (f.isTest !== null)
    activeChips.push({
      key: "isTest",
      label: f.isTest ? t("history.test_only") : t("history.hide_test"),
      clear: () => store.setFilter({ isTest: null }),
    });
  if (f.printer !== "all")
    activeChips.push({
      key: "printer",
      label: printerName(Number(f.printer)),
      clear: () => store.setFilter({ printer: "all" }),
    });
  if (f.dateFrom)
    activeChips.push({
      key: "dateFrom",
      label: `${t("history.filter_from")} ${f.dateFrom}`,
      clear: () => store.setFilter({ dateFrom: "" }),
    });
  if (f.dateTo)
    activeChips.push({
      key: "dateTo",
      label: `${t("history.filter_to")} ${f.dateTo}`,
      clear: () => store.setFilter({ dateTo: "" }),
    });

  // Phone card (PLAN.md phase 2): job + status stay visible without
  // horizontal scrolling; row actions move into a ⋯ menu; tapping the card
  // opens the details via the DataTable's onRowActivate.
  const historyCard = (job: HistoryJob) => (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm">#{job.id}</span>
          <JobStatusBadge status={job.status} />
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {printerName(job.printer_id)} · {fmtTime(job)} · {job.source}
        </p>
        {job.error && (
          <p className="truncate text-xs text-danger">{job.error}</p>
        )}
      </div>
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className="shrink-0"
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("common.actions_for", { name: `job ${job.id}` })}
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => store.setSelectedJob(job)}>
              <Eye className="h-4 w-4" aria-hidden="true" />
              {`View job ${job.id}`}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setConfirm({ kind: "reprint", job })}
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              {`Reprint job ${job.id}`}
            </DropdownMenuItem>
            {job.status === "failed" && (
              <DropdownMenuItem
                onSelect={() => setConfirm({ kind: "retry", job })}
              >
                {t("history.retry")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => setConfirm({ kind: "delete", job })}
              className="text-danger focus:text-danger"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              {`Delete job ${job.id}`}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <PageHeader title={t("history.title")} description={t("pages.history")}>
        <Button variant="outline" size="sm" onClick={handleExportCsv}>
          <Download className="h-4 w-4" aria-hidden="true" />
          {t("history.export_csv")}
        </Button>
      </PageHeader>

      {/* Filter bar stays visible while the table scrolls, but only from tablet width up:
          on a phone the six controls move into the bottom sheet below, leaving
          Search, the Filters button, and removable chips here. */}
      <div
        className="-mx-1 rounded-lg border bg-card p-3 shadow-[0_1px_0_hsl(var(--border))] md:sticky md:top-0 md:z-20"
        role="search"
        aria-label="Filter print jobs"
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-[180px] sm:flex-none">
            <Search
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              aria-label={t("common.search")}
              placeholder={t("common.search")}
              className="pl-9"
              value={f.search}
              onChange={(e) => store.setFilter({ search: e.target.value })}
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-control md:hidden"
            aria-expanded={filtersOpen}
            aria-haspopup="dialog"
            onClick={() => setFiltersOpen(true)}
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
            {t("history.filters")}
            {moreFiltersActive > 0 ? ` (${moreFiltersActive})` : ""}
          </Button>
          {/* Inline filters: md and up. On phones they live in the sheet below. */}
          {!isPhone && (
            <div id="history-more-filters" className="md:contents">
              {filterFields(false)}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-control">
                    <Bookmark className="h-4 w-4" aria-hidden="true" />
                    Saved filters
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[200px]">
                  <DropdownMenuLabel>Saved filters</DropdownMenuLabel>
                  {saved.length === 0 && (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                      None yet
                    </p>
                  )}
                  {saved.map((s) => (
                    <div key={s.name} className="flex items-center">
                      <DropdownMenuItem
                        className="flex-1"
                        onSelect={() => store.setFilter(s.filter)}
                      >
                        {s.name}
                      </DropdownMenuItem>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove saved filter ${s.name}`}
                        onClick={() => removeSaved(s.name)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={!filtersActive}
                    onSelect={() => setSaveOpen(true)}
                  >
                    Save current filters…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
          {filtersActive && (
            <Button
              variant="ghost"
              size="sm"
              className="h-control"
              onClick={store.clearFilter}
            >
              {t("common.clear")}
            </Button>
          )}
        </div>
        {/* Active filters as removable chips, under the search box. */}
        {activeChips.length > 0 && (
          <ul
            aria-label={t("history.active_filters")}
            className="mt-2 flex flex-wrap gap-1.5"
          >
            {activeChips.map((chip) => (
              <li key={chip.key}>
                <Badge variant="secondary" className="gap-1 py-1 pl-2.5 pr-1">
                  <span className="max-w-[12rem] truncate">{chip.label}</span>
                  <button
                    type="button"
                    onClick={chip.clear}
                    aria-label={t("history.remove_filter", {
                      name: chip.label,
                    })}
                    className="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Phone: the six controls live in a bottom sheet with labeled fields
          and an Apply/Reset footer, instead of pushing results off-screen. */}
      {isPhone && (
        <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
          <SheetContent
            side="bottom"
            className="flex max-h-[85dvh] w-full flex-col gap-0 p-0 pb-[env(safe-area-inset-bottom)]"
          >
            <DialogHeader className="border-b p-5 pr-12">
              <DialogTitle>{t("history.filters")}</DialogTitle>
              <DialogDescription>
                {t("history.filters_description")}
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 space-y-4 overflow-y-auto p-5">
              {filterFields(true)}
            </div>
            <DialogFooter className="gap-2 border-t p-5 sm:space-x-0">
              <Button variant="outline" onClick={() => store.clearFilter()}>
                {t("common.reset")}
              </Button>
              <Button onClick={() => setFiltersOpen(false)}>
                {t("common.apply")}
                {moreFiltersActive > 0 ? ` (${moreFiltersActive})` : ""}
              </Button>
            </DialogFooter>
          </SheetContent>
        </Sheet>
      )}

      {selected.size > 0 && (
        <div
          className={`flex flex-wrap items-center gap-2 rounded-lg border bg-accent px-3 py-2 text-sm${
            // Phone card mode: the bar sticks to the bottom of the scroll
            // area (above the bottom nav) so Reprint stays reachable.
            isPhone ? " sticky bottom-0 z-10 shadow-md" : ""
          }`}
          role="status"
        >
          <span className="font-medium text-accent-foreground">
            {selected.size} selected
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirm({ kind: "bulk-reprint" })}
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Reprint selected
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={selectedFailed.length === 0}
            onClick={() => setConfirm({ kind: "bulk-retry" })}
          >
            Retry failed ({selectedFailed.length})
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </Button>
        </div>
      )}

      <DataTable
        caption="Print jobs"
        columns={columns}
        data={filteredJobs}
        getRowId={(j) => String(j.id)}
        loading={loading}
        onRowActivate={(j) => store.setSelectedJob(j)}
        selection={{ selectedIds: selected, onChange: setSelected }}
        renderCard={historyCard}
        empty={{
          title: filtersActive
            ? "No jobs match these filters"
            : "No print jobs yet",
          description: filtersActive
            ? "Clear a filter to see more."
            : "Jobs appear here after you print.",
        }}
        footer={`${filteredJobs.length} of ${store.jobs.length} jobs`}
      />

      <ConfirmDialog
        open={confirm?.kind === "bulk-reprint"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Reprint ${selectedJobs.length} job(s)?`}
        description="Each selected job is sent to its printer again."
        confirmLabel="Reprint"
        busy={busy}
        onConfirm={() => runBulk(reprintOne, selectedJobs, "Queued reprint of")}
      />
      <ConfirmDialog
        open={confirm?.kind === "bulk-retry"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Retry ${selectedFailed.length} failed job(s)?`}
        confirmLabel="Retry"
        busy={busy}
        onConfirm={() => runBulk(retryOne, selectedFailed, "Re-queued")}
      />
      <ConfirmDialog
        open={confirm?.kind === "reprint"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={
          confirm?.kind === "reprint" ? `Reprint job #${confirm.job.id}?` : ""
        }
        description="The job is sent to its printer again."
        confirmLabel="Reprint"
        busy={busy}
        onConfirm={() =>
          confirm?.kind === "reprint" ? handleReprint(confirm.job) : undefined
        }
      />
      <ConfirmDialog
        open={confirm?.kind === "retry"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.kind === "retry" ? `Retry job #${confirm.job.id}?` : ""}
        description="The failed job is queued to print again."
        confirmLabel="Retry"
        busy={busy}
        onConfirm={() =>
          confirm?.kind === "retry" ? handleRetry(confirm.job) : undefined
        }
      />
      <ConfirmDialog
        open={confirm?.kind === "delete"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={
          confirm?.kind === "delete" ? `Delete job #${confirm.job.id}?` : ""
        }
        description="This removes the job from history. It cannot be undone."
        confirmLabel="Delete job"
        destructive
        busy={busy}
        onConfirm={() =>
          confirm?.kind === "delete" ? confirmDelete(confirm.job) : undefined
        }
      />

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save current filters</DialogTitle>
            <DialogDescription>
              Give this combination a name to reuse it later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="saved-filter-name">Name</Label>
            <Input
              id="saved-filter-name"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveCurrentFilter()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveCurrentFilter} disabled={!saveName.trim()}>
              Save filter
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!job} onOpenChange={() => store.setSelectedJob(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Job #{job?.id}</DialogTitle>
            <DialogDescription>{job ? fmtTime(job) : ""}</DialogDescription>
          </DialogHeader>
          {job && (
            <div className="space-y-4">
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Status</dt>
                  <dd>
                    <JobStatusBadge status={job.status} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Source</dt>
                  <dd>
                    <Badge variant="outline">{job.source}</Badge>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Printer</dt>
                  <dd>{printerName(job.printer_id)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Duration</dt>
                  <dd>
                    {job.duration_ms != null ? `${job.duration_ms} ms` : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Copies</dt>
                  <dd>{job.copies}</dd>
                </div>
              </dl>
              {job.error && (
                <div
                  role="alert"
                  className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
                >
                  {job.error}
                </div>
              )}
              {(() => {
                const tm = parseTimings(job.timings_json);
                return (
                  <div>
                    <p className="mb-1.5 text-xs text-muted-foreground">
                      Timing
                    </p>
                    {tm ? (
                      <TimingBreakdown timings={tm} variant="list" />
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No timing breakdown was recorded for this job.
                      </p>
                    )}
                  </div>
                );
              })()}
              {job.source_url && (
                <div>
                  <p className="text-xs text-muted-foreground">Source URL</p>
                  <p className="break-all font-mono text-xs">
                    {job.source_url}
                  </p>
                </div>
              )}
              {job.settings_json && (
                <div>
                  <p className="text-xs text-muted-foreground">Settings</p>
                  <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-xs">
                    {(() => {
                      try {
                        return JSON.stringify(
                          JSON.parse(job.settings_json),
                          null,
                          2,
                        );
                      } catch {
                        return job.settings_json;
                      } // malformed JSON must not crash the dialog
                    })()}
                  </pre>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            {job?.status === "failed" && (
              <Button
                variant="outline"
                onClick={() => {
                  handleRetry(job);
                  store.setSelectedJob(null);
                }}
              >
                {t("history.retry")}
              </Button>
            )}
            {job && (
              <Button
                onClick={() => {
                  handleReprint(job);
                  store.setSelectedJob(null);
                }}
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                {t("history.reprint")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
