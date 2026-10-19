import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "@/components/PageHeader";
import { invoke } from "@/lib/invoke";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DataTable } from "@/components/DataTable";
import { StatusBadge } from "@/components/StatusBadge";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Printer, Wifi, Usb, Bluetooth, Monitor, Trash2, TestTube, Scan, RefreshCw } from "lucide-react";
import { toast } from "sonner";


const PRINTER_TYPES = [
  { value: "ipp", label: "Wi-Fi / LAN (IPP)" },
  { value: "raw_tcp", label: "Wi-Fi / LAN (Raw TCP 9100)" },
  { value: "usb", label: "USB" },
  { value: "bluetooth", label: "Bluetooth" },
  { value: "system", label: "System" },
];

const LANGUAGES = [
  { value: "pdf", label: "PDF" },
  { value: "escpos", label: "ESC/POS (receipt)" },
  { value: "tspl", label: "TSPL (label)" },
  { value: "zpl", label: "ZPL (label)" },
  { value: "cpcl", label: "CPCL (label)" },
  { value: "raster", label: "Raster" },
];

const PAPERS = [
  { value: "58", label: "58 mm" },
  { value: "80", label: "80 mm" },
  { value: "100", label: "100 mm" },
  { value: "152", label: "4x6 in (152 mm)" },
  { value: "210", label: "A4 (210 mm)" },
];

interface SavedPrinter {
  id: number;
  name: string;
  printer_type: string;
  address: string;
  language: string;
  paper_width_mm: number | null;
  dpi: number | null;
  status?: string;
}

interface SystemPrinter {
  id: string;
  name: string;
  address: string;
  status?: string;
}

/** Tabs group printers by how they connect. */
const GROUPS = [
  { key: "all", label: "All", types: null as string[] | null },
  { key: "network", label: "Network", types: ["ipp", "raw_tcp"] },
  { key: "usb", label: "USB", types: ["usb"] },
  { key: "bluetooth", label: "Bluetooth", types: ["bluetooth"] },
  { key: "system", label: "System", types: ["system"] },
];

const TYPE_ICONS: Record<string, typeof Printer> = {
  ipp: Wifi,
  raw_tcp: Wifi,
  usb: Usb,
  bluetooth: Bluetooth,
  system: Monitor,
};

export function PrinterSetupPage() {
  const { t } = useTranslation();
  const [printers, setPrinters] = useState<SavedPrinter[]>([]);
  const [systemPrinters, setSystemPrinters] = useState<SystemPrinter[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("all");
  const [testing, setTesting] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<SavedPrinter | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    name: "",
    printer_type: "ipp",
    address: "",
    language: "pdf",
    paper_width_mm: "80",
    dpi: "203",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const saved = await invoke<SavedPrinter[]>("list_printers");
      setPrinters(saved ?? []);
    } catch (e) {
      toast.error(`Failed to load printers: ${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Discover OS printers for the "Add" dialog.
    invoke<SystemPrinter[]>("enumerate_system_printers")
      .then((list) => setSystemPrinters(list ?? []))
      .catch(() => setSystemPrinters([]));
  }, [load]);

  const refreshSystem = async () => {
    try {
      const list = await invoke<SystemPrinter[]>("enumerate_system_printers");
      setSystemPrinters(list ?? []);
      toast.success(`Found ${list.length} system printer(s)`);
    } catch (e) {
      toast.error(`Discovery failed: ${e}`);
    }
  };

  const scanAndAddSystem = async () => {
    setScanning(true);
    try {
      const list = await invoke<SystemPrinter[]>("enumerate_system_printers");
      if (!list || list.length === 0) {
        toast.info("No system printers found");
        return;
      }
      let added = 0;
      let skipped = 0;
      for (const sp of list) {
        if (printers.some((p) => p.name === sp.name)) {
          skipped++;
          continue;
        }
        try {
          await invoke("add_printer", {
            req: {
              name: sp.name,
              printer_type: "system",
              address: sp.address || sp.name,
              language: "pdf",
              paper_width_mm: 80,
              dpi: 203,
            },
          });
          added++;
        } catch {
          // ignore duplicate / validation errors per-printer
        }
      }
      await load();
      // refresh discovered list too
      setSystemPrinters(list);
      if (added > 0) toast.success(`Added ${added} system printer(s)${skipped ? `, ${skipped} already existed` : ""}`);
      else if (skipped) toast.info(`All ${skipped} system printer(s) already added`);
      else toast.info("No new system printers to add");
    } catch (e) {
      toast.error(`Scan failed: ${e}`);
    } finally {
      setScanning(false);
    }
  };

  const addPrinter = async () => {
    if (!form.name.trim()) {
      toast.error("Printer name is required");
      return;
    }
    if (!form.address.trim()) {
      toast.error("Address / port is required");
      return;
    }
    if (form.printer_type === "ipp" && !/^https?:\/\//i.test(form.address)) {
      toast.error("IPP address must start with http:// or https://");
      return;
    }

    try {
      await invoke("add_printer", {
        req: {
          name: form.name.trim(),
          printer_type: form.printer_type,
          address: form.address.trim(),
          language: form.language,
          paper_width_mm: Number(form.paper_width_mm),
          dpi: Number(form.dpi),
        },
      });
      toast.success(`Added "${form.name.trim()}"`);
      setShowAdd(false);
      setForm({
        name: "",
        printer_type: "ipp",
        address: "",
        language: "pdf",
        paper_width_mm: "80",
        dpi: "203",
      });
      await load();
    } catch (e) {
      const msg = String(e);
      toast.error(
        msg.includes("already exists") ? msg : `Failed to add printer: ${msg}`,
      );
    }
  };

  const removePrinter = async (p: SavedPrinter) => {
    try {
      await invoke("delete_printer", { id: p.id });
      setPrinters((prev) => prev.filter((x) => x.id !== p.id));
      toast.success(`Removed "${p.name}"`);
    } catch (e) {
      toast.error(`Failed to remove: ${e}`);
    }
  };

  const testPrinter = async (p: SavedPrinter) => {
    setTesting(p.id);
    try {
      await invoke("test_printer", { id: p.id });
      toast.success(`Test page sent to ${p.name}`);
    } catch (e) {
      toast.error(`Test print failed: ${e}`);
    } finally {
      setTesting(null);
    }
  };

  const counts = (types: string[] | null) =>
    types ? printers.filter((p) => types.includes(p.printer_type)).length : printers.length;
  const group = GROUPS.find((g) => g.key === tab) ?? GROUPS[0];
  const filtered = group.types ? printers.filter((p) => group.types?.includes(p.printer_type)) : printers;

  const columns = useMemo<ColumnDef<SavedPrinter>[]>(() => [
    {
      id: "name", header: "Printer", accessorFn: (p) => p.name.toLowerCase(), enableSorting: true,
      cell: (c) => {
        const p = c.row.original;
        const Icon = TYPE_ICONS[p.printer_type] ?? Printer;
        return (
          <div className="flex min-w-0 items-center gap-3">
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <p className="truncate font-medium">{p.name}</p>
              <p
                className="max-w-[140px] truncate font-mono text-xs text-muted-foreground sm:max-w-[260px]"
                title={p.address}
              >
                {p.address}
              </p>
            </div>
          </div>
        );
      },
    },
    {
      id: "status", header: "Status",
      cell: (c) => {
        const st = c.row.original.status;
        if (st === "online" || st === "offline") return <StatusBadge status={st} />;
        return <span className="text-xs text-muted-foreground">Not checked</span>;
      },
    },
    { id: "connection", header: "Connection", meta: { className: "hidden md:table-cell" }, cell: (c) => PRINTER_TYPES.find((x) => x.value === c.row.original.printer_type)?.label ?? c.row.original.printer_type },
    { id: "language", header: "Language", meta: { className: "hidden lg:table-cell" }, cell: (c) => LANGUAGES.find((x) => x.value === c.row.original.language)?.label ?? c.row.original.language },
    { id: "paper", header: "Paper", meta: { className: "hidden lg:table-cell" }, cell: (c) => (c.row.original.paper_width_mm ? `${c.row.original.paper_width_mm} mm` : "—") },
    {
      id: "actions", header: () => <span className="sr-only">Actions</span>, meta: { className: "text-right" },
      cell: (c) => {
        const p = c.row.original;
        return (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" disabled={testing === p.id} onClick={() => testPrinter(p)} aria-label={`Test print on ${p.name}`} title={t("printers.test_print")}>
              <TestTube className="h-4 w-4" aria-hidden="true" />
              {/* Icon-only on phones so the row fits; the aria-label keeps it named. */}
              <span className="hidden sm:inline">{testing === p.id ? "Testing…" : t("printers.test_print")}</span>
            </Button>
            <Button variant="ghost" size="icon" aria-label={`Remove ${p.name}`} title="Remove" onClick={() => setRemoveTarget(p)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        );
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [testing, t]);

  const field = "space-y-1.5";
  const addressLabel =
    form.printer_type === "system" ? "Printer name"
    : form.printer_type === "usb" ? "USB device ID"
    : form.printer_type === "bluetooth" ? "Bluetooth MAC or COM port"
    : "Address";
  const addressHint =
    form.printer_type === "ipp" ? "For example http://192.168.1.100"
    : form.printer_type === "raw_tcp" ? "For example 192.168.1.100:9100"
    : "";

  return (
    <div className="space-y-4">
      <PageHeader title={t("printers.title")} description={t("pages.printers")}>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Refresh
        </Button>
        <Button variant="outline" size="sm" onClick={scanAndAddSystem} disabled={scanning}>
          <Scan className="h-4 w-4" aria-hidden="true" />
          {scanning ? "Scanning…" : "Scan system"}
        </Button>
        <Button size="sm" onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("printers.add_printer")}
        </Button>
      </PageHeader>

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList>
          {GROUPS.map((g) => (
            <TabsTrigger key={g.key} value={g.key}>
              {g.label} ({counts(g.types)})
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={tab} className="mt-4">
      <DataTable
        caption="Printers"
        columns={columns}
        data={filtered}
        getRowId={(p) => String(p.id)}
        loading={loading}
        empty={{
          title: tab === "all" ? "No printers yet" : `No ${group.label.toLowerCase()} printers`,
          description: tab === "all" ? "Add a printer, or scan this computer for installed printers." : "Add one, or pick another group.",
          action: { label: "Add printer", onClick: () => setShowAdd(true) },
        }}
      />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={removeTarget != null}
        onOpenChange={(o) => { if (!o) setRemoveTarget(null); }}
        title={`Remove “${removeTarget?.name ?? ""}”?`}
        description="The printer is removed from PrintNinja. Past jobs stay in History."
        confirmLabel="Remove printer"
        destructive
        onConfirm={async () => { if (removeTarget) await removePrinter(removeTarget); setRemoveTarget(null); }}
      />

      {/* Setup lives in a side panel so the list stays in view */}
      <Sheet open={showAdd} onOpenChange={setShowAdd}>
        <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-md">
          <DialogHeader className="border-b p-5 pr-12">
            <DialogTitle>Add printer</DialogTitle>
            <DialogDescription>Connect a printer, then send a test page from the list.</DialogDescription>
          </DialogHeader>

          <div className="flex-1 space-y-4 p-5">
            {systemPrinters.length > 0 && (
              <div className="rounded-md border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-medium">Found on this computer</p>
                  <Button variant="ghost" size="sm" onClick={refreshSystem}>Rescan</Button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {systemPrinters.map((sp) => (
                    <Button
                      key={sp.id}
                      variant="outline"
                      size="sm"
                      onClick={() => setForm((f) => ({ ...f, name: sp.name, address: sp.name, printer_type: "system" }))}
                    >
                      {sp.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <div className={field}>
              <Label htmlFor="printer-name">Printer name</Label>
              <Input id="printer-name" value={form.name} placeholder="Front desk" onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className={field}>
                <Label htmlFor="printer-connection">Connection</Label>
                <Select value={form.printer_type} onValueChange={(v) => setForm((f) => ({ ...f, printer_type: v }))}>
                  <SelectTrigger id="printer-connection" aria-label="Connection"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRINTER_TYPES.map((x) => <SelectItem key={x.value} value={x.value}>{x.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className={field}>
                <Label htmlFor="printer-language">Language</Label>
                <Select value={form.language} onValueChange={(v) => setForm((f) => ({ ...f, language: v }))}>
                  <SelectTrigger id="printer-language" aria-label="Language"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LANGUAGES.map((x) => <SelectItem key={x.value} value={x.value}>{x.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className={field}>
              <Label htmlFor="printer-address">{addressLabel}</Label>
              <Input
                id="printer-address"
                value={form.address}
                aria-describedby={addressHint ? "printer-address-hint" : undefined}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
              />
              {addressHint && <p id="printer-address-hint" className="text-xs text-muted-foreground">{addressHint}</p>}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className={field}>
                <Label htmlFor="printer-paper">Paper width</Label>
                <Select value={form.paper_width_mm} onValueChange={(v) => setForm((f) => ({ ...f, paper_width_mm: v }))}>
                  <SelectTrigger id="printer-paper" aria-label="Paper width"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PAPERS.map((x) => <SelectItem key={x.value} value={x.value}>{x.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className={field}>
                <Label htmlFor="printer-dpi">DPI</Label>
                <Select value={form.dpi} onValueChange={(v) => setForm((f) => ({ ...f, dpi: v }))}>
                  <SelectTrigger id="printer-dpi" aria-label="DPI"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="203">203</SelectItem>
                    <SelectItem value="300">300</SelectItem>
                    <SelectItem value="600">600</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2 border-t p-5 sm:space-x-0">
            <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button onClick={addPrinter}>Save printer</Button>
          </DialogFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
