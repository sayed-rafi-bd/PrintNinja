import { useCallback, useEffect, useRef, useState } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Palette,
  Globe,
  Key,
  Link,
  Shield,
  Download,
  Eye,
  EyeOff,
  Trash2,
  Upload,
  Plus,
  Info,
} from "lucide-react";
import { toast } from "sonner";
import { useTheme } from "@/lib/theme/ThemeProvider";
import { diagnostics } from "@/lib/diagnostics";

interface ApiStatus {
  running: boolean;
  address: string;
  port: number;
  lan_access: boolean;
}

interface FontRow {
  id: number;
  family: string;
  format: string;
}

const DEFAULT_KEY = "— not generated —";

/**
 * Settings are stored in SQLite via Tauri. In web mode (browser preview,
 * CI) the command is unavailable, so fall back to localStorage so the page
 * stays usable instead of silently discarding every write.
 */
const isWebMode = () =>
  typeof window !== "undefined" && !(window as any).__TAURI_INTERNALS__;

const lsKey = (key: string) => `printninja-setting:${key}`;

async function readSetting(key: string): Promise<string | null> {
  if (isWebMode()) return localStorage.getItem(lsKey(key));
  try {
    return await invoke<string | null>("get_setting", { key });
  } catch {
    return localStorage.getItem(lsKey(key));
  }
}

async function writeSetting(key: string, value: string): Promise<boolean> {
  localStorage.setItem(lsKey(key), value);
  if (isWebMode()) return true;
  try {
    await invoke("set_setting", { key, value });
    return true;
  } catch (e) {
    // Persisted locally at least; surface the backend problem.
    console.warn(`set_setting(${key}) failed, kept in localStorage:`, e);
    return true;
  }
}

export function SettingsPage() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [appVersion, setAppVersion] = useState<string>("");

  const [apiPort, setApiPort] = useState("17717");
  const [lanAccess, setLanAccess] = useState(false);
  const [apiKey, setApiKey] = useState(DEFAULT_KEY);
  const [showKey, setShowKey] = useState(false);
  const [apiStatus, setApiStatus] = useState<ApiStatus | null>(null);
  const [starting, setStarting] = useState(false);

  const [retentionDays, setRetentionDays] = useState("30");
  const [maxRecords, setMaxRecords] = useState("10000");

  const [allowedDomains, setAllowedDomains] = useState("");
  const [blockPrivate, setBlockPrivate] = useState(true);

  const [trusted, setTrusted] = useState<string[]>([]);
  const [newTrusted, setNewTrusted] = useState("");

  const [fonts, setFonts] = useState<FontRow[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadFonts = useCallback(async () => {
    try {
      setFonts((await invoke<FontRow[]>("list_fonts")) ?? []);
    } catch {
      /* backend unavailable */
    }
  }, []);

  const loadApiStatus = useCallback(async () => {
    if (isWebMode()) {
      const port = await readSetting("api_port");
      const lan = await readSetting("api_lan_access");
      setApiStatus({
        running: false,
        address: lan === "true" ? "0.0.0.0" : "127.0.0.1",
        port: Number(port) || 17717,
        lan_access: lan === "true",
      });
      return;
    }
    try {
      setApiStatus(await invoke<ApiStatus>("get_api_status"));
    } catch {
      /* backend unavailable */
    }
  }, []);

  // Load app version
  useEffect(() => {
    (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        const v = await getVersion();
        setAppVersion(v);
      } catch {
        // web mode: Tauri not available
        setAppVersion("");
      }
    })();
  }, []);

  // Load persisted settings on mount.
  useEffect(() => {
    (async () => {
      const [port, lan, days, max, domains, block] = await Promise.all([
        readSetting("api_port"),
        readSetting("api_lan_access"),
        readSetting("retention_days"),
        readSetting("max_records"),
        readSetting("allowed_domains"),
        readSetting("block_private_ips"),
      ]);
      if (port) setApiPort(port);
      if (lan) setLanAccess(lan === "true");
      if (days) setRetentionDays(days);
      if (max) setMaxRecords(max);
      if (domains) setAllowedDomains(domains);
      if (block !== null) setBlockPrivate(block === "true");

      try {
        if (isWebMode()) {
          const raw = localStorage.getItem(lsKey("trusted_sources"));
          setTrusted(raw ? (JSON.parse(raw) as string[]) : []);
        } else {
          setTrusted((await invoke<string[]>("get_trusted_sources")) ?? []);
        }
      } catch {
        setTrusted([]);
      }
    })();
    loadApiStatus();
    loadFonts();
  }, [loadApiStatus, loadFonts]);

  const startApi = async () => {
    setStarting(true);
    try {
      const addr = await invoke<string>("start_api_server", {
        port: Number(apiPort),
        lanAccess,
      });
      toast.success(`API server listening on ${addr}`);
      await writeSetting("api_port", apiPort);
      await writeSetting("api_lan_access", String(lanAccess));
      await loadApiStatus();
    } catch (e) {
      toast.error(`Failed to start: ${e}`);
    } finally {
      setStarting(false);
    }
  };

  const stopApi = async () => {
    try {
      await invoke("stop_api_server");
      toast.success("API server stopped");
      await loadApiStatus();
    } catch (e) {
      toast.error(`Failed to stop: ${e}`);
    }
  };

  const regenerateKey = async () => {
    try {
      const key = await invoke<string>("regenerate_api_key");
      setApiKey(key);
      setShowKey(true);
      toast.success("New API key generated — copy it now, it is not shown again");
    } catch (e) {
      toast.error(`Failed: ${e}`);
    }
  };

  const copyKey = async () => {
    if (apiKey === DEFAULT_KEY) return;
    try {
      await navigator.clipboard.writeText(apiKey);
      toast.success("API key copied");
    } catch {
      toast.error("Clipboard unavailable — reveal and copy manually");
    }
  };

  const uploadFont = async (file: File) => {
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      await invoke("upload_font", {
        fileName: file.name,
        fileData: bytes,
        family: null,
      });
      toast.success(`Uploaded ${file.name}`);
      await loadFonts();
    } catch (e) {
      toast.error(`Upload failed: ${e}`);
    }
  };

  const addTrusted = async () => {
    const value = newTrusted.trim();
    if (!value) return;
    const next = [...trusted, value];
    if (await writeSetting("trusted_sources", JSON.stringify(next))) {
      setTrusted(next);
      setNewTrusted("");
      toast.success(`Trusted source added`);
    }
  };

  const removeTrusted = async (value: string) => {
    const next = trusted.filter((x) => x !== value);
    if (await writeSetting("trusted_sources", JSON.stringify(next))) {
      setTrusted(next);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">{t("settings_page.title")}</h1>

      <Tabs defaultValue="general" className="w-full">
        <TabsList className="w-full overflow-x-auto flex-nowrap justify-start gap-1 h-auto p-1">
          <TabsTrigger value="general" className="gap-2">
            <Palette className="h-4 w-4" />
            General
          </TabsTrigger>
          <TabsTrigger value="fonts" className="gap-2">
            <Globe className="h-4 w-4" />
            {t("settings_page.fonts")}
          </TabsTrigger>
          <TabsTrigger value="api" className="gap-2">
            <Key className="h-4 w-4" />
            {t("settings_page.api")}
          </TabsTrigger>
          <TabsTrigger value="deeplinks" className="gap-2">
            <Link className="h-4 w-4" />
            {t("settings_page.deep_links")}
          </TabsTrigger>
          <TabsTrigger value="security" className="gap-2">
            <Shield className="h-4 w-4" />
            Security
          </TabsTrigger>
        </TabsList>

        {/* ── General ─────────────────────────────────────────────── */}
        <TabsContent value="general" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t("settings_page.theme")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Select value={theme} onValueChange={(v) => setTheme(v as "light" | "dark" | "system")}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">
                    {t("settings_page.light")}
                  </SelectItem>
                  <SelectItem value="dark">{t("settings_page.dark")}</SelectItem>
                  <SelectItem value="system">
                    {t("settings_page.system")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t("settings_page.retention")}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="retention-days">Keep history for (days)</Label>
                <Input
                  id="retention-days"
                  type="number"
                  min="1"
                  value={retentionDays}
                  onChange={(e) => setRetentionDays(e.target.value)}
                  onBlur={() => writeSetting("retention_days", retentionDays)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="max-records">Max records</Label>
                <Input
                  id="max-records"
                  type="number"
                  min="100"
                  value={maxRecords}
                  onChange={(e) => setMaxRecords(e.target.value)}
                  onBlur={() => writeSetting("max_records", maxRecords)}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Diagnostics</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Export application logs and diagnostics for troubleshooting.
              </p>
              <Button
                variant="outline"
                onClick={() => {
                  diagnostics.download();
                  toast.success("Diagnostics exported");
                }}
              >
                <Download className="h-4 w-4 mr-2" />
                Export Diagnostics
              </Button>
              <p className="text-xs text-muted-foreground">
                Secrets and API tokens are redacted from the export.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Fonts ───────────────────────────────────────────────── */}
        <TabsContent value="fonts" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Installed Fonts</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {fonts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No custom fonts installed. Noto Sans is bundled.
                </p>
              ) : (
                fonts.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-center justify-between p-3 rounded-md border"
                  >
                    <div>
                      <p className="text-sm font-medium">{f.family}</p>
                      <p className="text-xs text-muted-foreground uppercase">
                        {f.format}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove ${f.family}`}
                      onClick={async () => {
                        try {
                          await invoke("delete_font", { id: f.id });
                          await loadFonts();
                          toast.success(`Removed ${f.family}`);
                        } catch (e) {
                          toast.error(`Failed: ${e}`);
                        }
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))
              )}

              <input
                ref={fileRef}
                type="file"
                accept=".ttf,.otf,.woff,.woff2"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadFont(f);
                  e.target.value = "";
                }}
              />
              <Button variant="outline" onClick={() => fileRef.current?.click()}>
                <Upload className="h-4 w-4" />
                Upload Font (TTF, OTF, WOFF2)
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── API ─────────────────────────────────────────────────── */}
        <TabsContent value="api" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Local REST API</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between p-3 rounded-md border">
                <div>
                  <p className="text-sm font-medium">Status</p>
                  <p className="text-xs text-muted-foreground">
                    {apiStatus?.running
                      ? `${apiStatus.address}:${apiStatus.port}`
                      : `Default: ${lanAccess ? "0.0.0.0" : "127.0.0.1"}:${apiPort}`}
                  </p>
                </div>
                <Badge variant={apiStatus?.running ? "success" : "secondary"}>
                  {apiStatus?.running ? "running" : "disabled"}
                </Badge>
              </div>

              <div className="space-y-1">
                <Label htmlFor="api-port">Port</Label>
                <Input
                  id="api-port"
                  type="number"
                  min="1"
                  max="65535"
                  value={apiPort}
                  onChange={(e) => setApiPort(e.target.value)}
                  disabled={apiStatus?.running}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Switch
                    id="lan-access"
                    checked={lanAccess}
                    disabled={apiStatus?.running}
                    onCheckedChange={(v) => {
                      setLanAccess(v);
                      writeSetting("api_lan_access", String(v));
                    }}
                  />
                  <Label htmlFor="lan-access">Allow LAN access</Label>
                </div>
                {apiStatus?.running ? (
                  <Button variant="destructive" onClick={stopApi}>
                    Stop Server
                  </Button>
                ) : (
                  <Button onClick={startApi} disabled={starting}>
                    {starting ? "Starting…" : "Start Server"}
                  </Button>
                )}
              </div>

              {lanAccess && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  LAN access is enabled: anyone on your network who has an API
                  key can trigger prints.
                </p>
              )}

              <div className="space-y-1">
                <Label>API Key</Label>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    aria-label="API key"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={showKey ? "Hide key" : "Reveal key"}
                    onClick={() => setShowKey((s) => !s)}
                  >
                    {showKey ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                  <Button variant="outline" onClick={copyKey}>
                    Copy
                  </Button>
                  <Button variant="outline" onClick={regenerateKey}>
                    Regenerate
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Only a hash is stored. Regenerating invalidates the old key.
                </p>
              </div>

              <div className="rounded-md bg-muted p-3">
                <p className="text-xs font-medium mb-1">curl example</p>
                <pre className="text-[11px] overflow-x-auto">{`curl -X POST http://127.0.0.1:${apiPort}/v1/print \\
  -H "Authorization: Bearer ${apiKey === DEFAULT_KEY ? "<your-key>" : apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"template":"Receipt","printer":"Front Desk","data":{"order":1042}}'`}</pre>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Deep links ──────────────────────────────────────────── */}
        <TabsContent value="deeplinks" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Trusted Sources</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Sources listed here skip the print confirmation sheet.
              </p>
              {trusted.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No trusted sources yet — every deep link asks for
                  confirmation.
                </p>
              ) : (
                trusted.map((src) => (
                  <div
                    key={src}
                    className="flex items-center justify-between p-3 rounded-md border"
                  >
                    <span className="text-sm font-mono">{src}</span>
                    <div className="flex items-center gap-2">
                      <Badge variant="success">Trusted</Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove ${src}`}
                        onClick={() => removeTrusted(src)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                ))
              )}

              <div className="flex gap-2">
                <Input
                  placeholder="pos.local or com.example.app"
                  value={newTrusted}
                  onChange={(e) => setNewTrusted(e.target.value)}
                />
                <Button variant="outline" onClick={addTrusted}>
                  <Plus className="h-4 w-4" />
                  Add
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Security ────────────────────────────────────────────── */}
        <TabsContent value="security" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Data Sources</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="allowed-domains">
                  {t("settings_page.allowed_domains")}
                </Label>
                <Input
                  id="allowed-domains"
                  placeholder="api.example.com, pos.local"
                  value={allowedDomains}
                  onChange={(e) => setAllowedDomains(e.target.value)}
                  onBlur={() =>
                    writeSetting("allowed_domains", allowedDomains)
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Comma-separated. Leave empty to allow any domain.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="block-private"
                  checked={blockPrivate}
                  onCheckedChange={(v) => {
                    setBlockPrivate(v);
                    writeSetting("block_private_ips", String(v));
                  }}
                />
                <Label htmlFor="block-private">Block private IP ranges</Label>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Version footer */}
      <div className="flex items-center justify-center gap-2 pt-4 text-xs text-muted-foreground border-t">
        <Info className="h-3 w-3" />
        <span>PrintNinja {appVersion ? `v${appVersion}` : "v0.1.3"}</span>
        <span className="opacity-50">·</span>
        <span className="hidden sm:inline">com.printninja.desktop</span>
      </div>
    </div>
  );
}