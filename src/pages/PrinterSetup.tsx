import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Plus,
  Printer,
  Wifi,
  Usb,
  Bluetooth,
  Monitor,
  Trash2,
  TestTube,
  Scan,
} from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/EmptyState";

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

  const filtered = printers.filter((p) =>
    tab === "all" ? true : p.printer_type === tab,
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">{t("printers.title")}</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load}>
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={scanAndAddSystem} disabled={scanning}>
            <Scan className="h-4 w-4" />
            {scanning ? "Scanning…" : "Scan System"}
          </Button>
          <Button size="sm" onClick={() => setShowAdd(true)}>
            <Plus className="h-4 w-4" />
            {t("printers.add_printer")}
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="wifi">Wi-Fi / LAN</TabsTrigger>
          <TabsTrigger value="usb">USB</TabsTrigger>
          <TabsTrigger value="bluetooth">Bluetooth</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
        </TabsList>

        {["all", "wifi", "usb", "bluetooth", "system"].map((key) => (
          <TabsContent key={key} value={key} className="mt-4">
            {loading ? (
              <p className="py-12 text-center text-muted-foreground">
                Loading printers…
              </p>
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={Printer}
                title="No printers configured"
                description={
                  tab === "all"
                    ? "Add your first printer to start printing."
                    : `No ${tab === "wifi" ? "Wi-Fi / LAN" : tab} printers yet.`
                }
                action={{
                  label: "Add Printer",
                  onClick: () => setShowAdd(true),
                }}
              />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filtered.map((printer) => {
                  const Icon =
                    TYPE_ICONS[printer.printer_type] ?? Printer;
                  const online = printer.status !== "offline";
                  return (
                    <Card key={printer.id}>
                      <CardHeader className="pb-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="p-2 rounded-md bg-secondary shrink-0">
                              <Icon className="h-5 w-5" />
                            </div>
                            <div className="min-w-0">
                              <CardTitle className="text-base truncate">
                                {printer.name}
                              </CardTitle>
                              <p className="text-xs text-muted-foreground truncate">
                                {printer.address}
                              </p>
                            </div>
                          </div>
                          <Badge
                            variant={online ? "success" : "secondary"}
                            className="shrink-0"
                          >
                            {online ? "online" : "offline"}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="outline">
                            {printer.printer_type}
                          </Badge>
                          <Badge variant="outline">
                            {printer.language}
                          </Badge>
                          {printer.paper_width_mm && (
                            <Badge variant="outline">
                              {printer.paper_width_mm}mm
                            </Badge>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-1"
                            disabled={testing === printer.id}
                            onClick={() => testPrinter(printer)}
                          >
                            <TestTube className="h-3 w-3" />
                            {testing === printer.id
                              ? "Testing…"
                              : t("printers.test_print")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Remove ${printer.name}`}
                            onClick={() => removePrinter(printer)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>

      {/* Add / Edit printer */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Add Printer</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            {systemPrinters.length > 0 && (
              <div className="rounded-md border p-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-medium">
                    Discovered system printers
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs"
                    onClick={refreshSystem}
                  >
                    Rescan
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1">
                  {systemPrinters.map((sp) => (
                    <Button
                      key={sp.id}
                      variant="outline"
                      size="sm"
                      className="h-6 text-xs"
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          name: sp.name,
                          address: sp.name,
                          printer_type: "system",
                        }))
                      }
                    >
                      {sp.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-1">
              <Label htmlFor="printer-name">Printer Name</Label>
              <Input
                id="printer-name"
                value={form.name}
                placeholder="e.g. Front Desk"
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Connection</Label>
                <Select
                  value={form.printer_type}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, printer_type: v }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRINTER_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label>Language</Label>
                <Select
                  value={form.language}
                  onValueChange={(v) => setForm((f) => ({ ...f, language: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGES.map((l) => (
                      <SelectItem key={l.value} value={l.value}>
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="printer-address">
                {form.printer_type === "system"
                  ? "Printer name"
                  : form.printer_type === "usb"
                    ? "USB device id"
                    : form.printer_type === "bluetooth"
                      ? "Bluetooth MAC / COM port"
                      : "Address (e.g. http://192.168.1.100 or 192.168.1.100:9100)"}
              </Label>
              <Input
                id="printer-address"
                value={form.address}
                placeholder="192.168.1.100"
                onChange={(e) =>
                  setForm((f) => ({ ...f, address: e.target.value }))
                }
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Paper Width</Label>
                <Select
                  value={form.paper_width_mm}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, paper_width_mm: v }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAPERS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>DPI</Label>
                <Select
                  value={form.dpi}
                  onValueChange={(v) => setForm((f) => ({ ...f, dpi: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="203">203</SelectItem>
                    <SelectItem value="300">300</SelectItem>
                    <SelectItem value="600">600</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
            <Button onClick={addPrinter}>Save Printer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}