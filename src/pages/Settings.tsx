import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AppearanceSettings } from "@/components/AppearanceSettings";
import { SyncStatusCard } from "@/components/SyncStatusCard";
import { PageHeader } from "@/components/PageHeader";
import { SetupChecklist } from "@/components/SetupChecklist";
import {
  AndroidBackgroundControls,
  isAndroidBackground,
} from "@/components/BackgroundAndroid";
import { parseSection, type SettingsSection } from "@/lib/setup/checklist";
import { agent } from "@/lib/agent/commands";
import {
  isWebMode,
  readSetting,
  settingsLsKey,
  writeSetting,
} from "@/lib/settings";
import type { ApiStatus, FontRow } from "@/lib/agent/types";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Type,
  Archive,
  Activity,
  AppWindow,
  Globe,
  Key,
  Shield,
  Download,
  Eye,
  EyeOff,
  Trash2,
  Upload,
  Plus,
  Info,
  ListChecks,
} from "lucide-react";
import { ChangePasswordForm } from "@/components/ChangePasswordForm";
import { toast } from "sonner";
import { diagnostics } from "@/lib/diagnostics";
import * as share from "@/lib/share/client";
import { normalizeServiceUrl } from "@/lib/share/session";

const DEFAULT_KEY = "— not generated —";

export function SettingsPage() {
  const { t } = useTranslation();
  const [appVersion, setAppVersion] = useState<string>("");
  const [searchParams, setSearchParams] = useSearchParams();
  const section = parseSection(searchParams.get("section"));
  const openSection = (next: SettingsSection) => {
    const params = new URLSearchParams(searchParams);
    if (next === "general") params.delete("section");
    else params.set("section", next);
    setSearchParams(params, { replace: true });
  };

  const [apiPort, setApiPort] = useState("17717");
  const [lanAccess, setLanAccess] = useState(false);
  const [apiKey, setApiKey] = useState(DEFAULT_KEY);
  const [showKey, setShowKey] = useState(false);
  const [apiStatus, setApiStatus] = useState<ApiStatus | null>(null);
  const [starting, setStarting] = useState(false);

  const [retentionError, setRetentionError] = useState("");
  const [maxError, setMaxError] = useState("");
  const [retentionDays, setRetentionDays] = useState("30");
  const [maxRecords, setMaxRecords] = useState("10000");

  const [allowedDomains, setAllowedDomains] = useState("");
  const [blockPrivate, setBlockPrivate] = useState(true);
  const [domainsError, setDomainsError] = useState("");
  const [allowAllOpen, setAllowAllOpen] = useState(false);
  // Last persisted value: clearing a non-empty allowlist is allow-all,
  // which needs an explicit confirm.
  const lastSavedDomains = useRef<string | null>(null);

  const [launchAtStartup, setLaunchAtStartup] = useState(false);
  const [startMinimized, setStartMinimized] = useState(false);
  const [minimizeToTray, setMinimizeToTray] = useState(false);
  const [closeToTray, setCloseToTray] = useState(true);
  const [bgServiceRunning, setBgServiceRunning] = useState<boolean | null>(
    null,
  );
  const [batteryExempt, setBatteryExempt] = useState<boolean | null>(null);
  const [bgBusy, setBgBusy] = useState(false);

  const [trusted, setTrusted] = useState<string[]>([]);
  const [newTrusted, setNewTrusted] = useState("");

  const [fonts, setFonts] = useState<FontRow[]>([]);
  const [fontUploadError, setFontUploadError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  const [shareUrl, setShareUrl] = useState("");
  const [shareHandle, setShareHandle] = useState("");
  const [sharePassword, setSharePassword] = useState("");
  const [shareUser, setShareUser] = useState<{ handle: string } | null>(null);
  const [shareBusy, setShareBusy] = useState(false);

  const loadFonts = useCallback(async () => {
    try {
      setFonts((await agent("list_fonts", {})) ?? []);
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
      setApiStatus(await agent("get_api_status", {}));
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
      const [
        port,
        lan,
        days,
        max,
        domains,
        block,
        startup,
        minimized,
        minTray,
        closeTray,
      ] = await Promise.all([
        readSetting("api_port"),
        readSetting("api_lan_access"),
        readSetting("retention_days"),
        readSetting("max_records"),
        readSetting("allowed_domains"),
        readSetting("block_private_ips"),
        readSetting("launch_at_startup"),
        readSetting("start_minimized"),
        readSetting("minimize_to_tray"),
        readSetting("close_to_tray"),
      ]);
      if (port) setApiPort(port);
      if (lan) setLanAccess(lan === "true");
      if (days) setRetentionDays(days);
      if (max) setMaxRecords(max);
      if (domains) setAllowedDomains(domains);
      lastSavedDomains.current = domains ?? "";
      if (block !== null) setBlockPrivate(block === "true");
      if (startup !== null)
        setLaunchAtStartup(startup === "true" || startup === "1");
      if (minimized !== null)
        setStartMinimized(minimized === "true" || minimized === "1");
      if (minTray !== null)
        setMinimizeToTray(minTray === "true" || minTray === "1");
      if (closeTray !== null)
        setCloseToTray(closeTray === "true" || closeTray === "1");

      try {
        if (isWebMode()) {
          const raw = localStorage.getItem(settingsLsKey("trusted_sources"));
          setTrusted(raw ? (JSON.parse(raw) as string[]) : []);
        } else {
          setTrusted((await agent("get_trusted_sources", {})) ?? []);
        }
      } catch {
        setTrusted([]);
      }
      // Share service
      try {
        const url = await share.getServiceUrl();
        if (url) setShareUrl(url);
        const token = await share.getSessionToken();
        if (token && url) {
          try {
            const me = await share.fetchMe();
            setShareUser({ handle: me.handle });
          } catch {}
        }
      } catch {}
    })();
    loadApiStatus();
    loadFonts();
  }, [loadApiStatus, loadFonts]);

  // Same behaviour for every numeric setting: validate, save, and say so.
  const saveNumber = async (
    key: string,
    value: string,
    min: number,
    label: string,
    setErr: (m: string) => void,
  ) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min) {
      setErr(`${label} must be a whole number of at least ${min}.`);
      return;
    }
    setErr("");
    await writeSetting(key, String(n));
    toast.success("Setting saved");
  };

  // One behavior for every background toggle: persist the key, ask the
  // backend to re-apply autostart/tray without a restart, and say so.
  const setBackgroundPref = async (
    key: string,
    value: boolean,
    set: (v: boolean) => void,
  ) => {
    set(value);
    await writeSetting(key, value ? "1" : "0");
    try {
      await agent("refresh_background", {});
    } catch {
      // Web preview or an old backend: the stored value still applies
      // at the next launch.
    }
    toast.success("Background setting saved");
  };

  const startApi = async () => {
    setStarting(true);
    try {
      const addr = await agent("start_api_server", {
        port: Number(apiPort),
        lan_access: lanAccess,
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
      await agent("stop_api_server", {});
      toast.success("API server stopped");
      await loadApiStatus();
    } catch (e) {
      toast.error(`Failed to stop: ${e}`);
    }
  };

  const regenerateKey = async () => {
    try {
      const key = await agent("regenerate_api_key", {});
      setApiKey(key);
      setShowKey(true);
      toast.success(
        "New API key generated — copy it now, it is not shown again",
      );
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

  // A completed pull may bring another PC's fonts (or confirm a
  // delete); reload so the list shows it with no manual step (F10).
  useEffect(() => {
    const onPulled = () => {
      void loadFonts();
    };
    window.addEventListener("sync:pulled", onPulled);
    return () => window.removeEventListener("sync:pulled", onPulled);
  }, [loadFonts]);

  const uploadFont = async (file: File) => {
    setFontUploadError("");
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      await agent("upload_font", {
        file_name: file.name,
        file_data: bytes,
        family: null,
      });
      toast.success(`Uploaded ${file.name}`);
      await loadFonts();
      // Stored locally for now; sending fonts to the server gets its own
      // explicit action in phase 2.
    } catch (e) {
      // The wrong content (a non-font with a font extension) must read
      // inline, not just in a toast (F10).
      setFontUploadError(`Upload failed: ${e}`);
    }
  };

  // Single write path for trusted sources: the dedicated command in
  // app mode, localStorage in web mode (or when the backend is down).
  // Previously add/remove wrote the raw setting key while load read
  // through get_trusted_sources — two formats that could diverge.
  const persistTrusted = async (next: string[]) => {
    const clean = [...new Set(next.map((s) => s.trim()).filter(Boolean))];
    if (isWebMode()) {
      localStorage.setItem(
        settingsLsKey("trusted_sources"),
        JSON.stringify(clean),
      );
    } else {
      try {
        await agent("set_trusted_sources", { sources: clean });
      } catch {
        localStorage.setItem(
          settingsLsKey("trusted_sources"),
          JSON.stringify(clean),
        );
      }
    }
    setTrusted(clean);
  };

  const addTrusted = async () => {
    const value = newTrusted.trim();
    if (!value) return;
    if (trusted.includes(value)) {
      toast.info("That source is already trusted");
      return;
    }
    await persistTrusted([...trusted, value]);
    setNewTrusted("");
    toast.success(`Trusted source added`);
  };

  const removeTrusted = async (value: string) => {
    await persistTrusted(trusted.filter((x) => x !== value));
  };

  // Hostnames only: no scheme, path, port-range or spaces. An empty
  // field means allow-all, so clearing a non-empty list asks first.
  const saveAllowedDomains = async (raw: string) => {
    const entries = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const bad = entries.find(
      (e) =>
        !/^(?=.{1,253}$)[a-z0-9]([a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i.test(
          e,
        ) || e.includes(".."),
    );
    if (bad) {
      setDomainsError(
        `“${bad}” is not a domain — use hostnames like api.example.com, comma-separated`,
      );
      return;
    }
    setDomainsError("");
    const normalized = entries.join(", ");
    if (normalized === "") {
      if (lastSavedDomains.current) {
        setAllowAllOpen(true);
        return;
      }
      return;
    }
    await writeSetting("allowed_domains", normalized);
    if (normalized !== raw) setAllowedDomains(normalized);
    lastSavedDomains.current = normalized;
    toast.success("Allowed domains updated");
  };

  const saveShareUrl = async () => {
    const typed = shareUrl.trim();
    const next = typed ? normalizeServiceUrl(typed) : null;
    if (typed && !next) {
      toast.error("Enter the full address, starting with http:// or https://");
      return;
    }
    const current = await share.getServiceUrl();
    if (next === current) {
      toast.success("Service URL unchanged");
      return;
    }
    const hadSession = !!(await share.getSessionToken());
    await share.setServiceUrl(next);
    setShareUrl(next ?? "");
    if (hadSession) {
      // The session token belongs to the old server. Drop it and return to the
      // sign-in screen, which is prefilled with the new address.
      setShareUser(null);
      await share.endSession("signed_out");
    }
    toast.success("Service URL saved");
  };

  const doRegister = async () => {
    if (!shareUrl.trim() || !shareHandle.trim() || !sharePassword) {
      toast.error("Service URL, handle and password required");
      return;
    }
    setShareBusy(true);
    try {
      const res = await share.register(shareHandle.trim(), sharePassword);
      setShareUser({ handle: res.user.handle });
      setSharePassword("");
      toast.success(`Registered as ${res.user.handle}`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setShareBusy(false);
    }
  };

  const doLogin = async () => {
    if (!shareUrl.trim() || !shareHandle.trim() || !sharePassword) {
      toast.error("Service URL, handle and password required");
      return;
    }
    setShareBusy(true);
    try {
      const res = await share.login(shareHandle.trim(), sharePassword);
      setShareUser({ handle: res.user.handle });
      setSharePassword("");
      toast.success(`Signed in as ${res.user.handle}`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setShareBusy(false);
    }
  };

  const doLogout = async () => {
    setShareBusy(true);
    try {
      await share.logout();
      setShareUser(null);
      toast.success("Signed out");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setShareBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("settings_page.title")}
        description={t("pages.settings")}
      />

      <Tabs
        value={section}
        onValueChange={(v) => openSection(v as SettingsSection)}
        orientation="vertical"
        className="flex flex-col gap-4 md:flex-row md:items-start md:gap-8"
      >
        <TabsList
          aria-label="Settings sections"
          className="h-auto w-full shrink-0 flex-row items-stretch justify-start gap-1 overflow-x-auto bg-transparent p-0 md:w-56 md:flex-col md:overflow-visible"
        >
          <TabsTrigger
            value="setup"
            className="justify-start gap-2 data-[state=active]:bg-accent data-[state=active]:text-accent-foreground data-[state=active]:shadow-none"
          >
            <ListChecks className="h-4 w-4 shrink-0" aria-hidden="true" />
            Setup
          </TabsTrigger>
          <TabsTrigger
            value="general"
            className="justify-start gap-2 data-[state=active]:bg-accent data-[state=active]:text-accent-foreground data-[state=active]:shadow-none"
          >
            <Type className="h-4 w-4 shrink-0" aria-hidden="true" />
            General
          </TabsTrigger>
          <TabsTrigger
            value="background"
            className="justify-start gap-2 data-[state=active]:bg-accent data-[state=active]:text-accent-foreground data-[state=active]:shadow-none"
          >
            <AppWindow className="h-4 w-4 shrink-0" aria-hidden="true" />
            Background
          </TabsTrigger>
          <TabsTrigger
            value="share"
            className="justify-start gap-2 data-[state=active]:bg-accent data-[state=active]:text-accent-foreground data-[state=active]:shadow-none"
          >
            <Globe className="h-4 w-4 shrink-0" aria-hidden="true" />
            Share
          </TabsTrigger>
          <TabsTrigger
            value="api"
            className="justify-start gap-2 data-[state=active]:bg-accent data-[state=active]:text-accent-foreground data-[state=active]:shadow-none"
          >
            <Key className="h-4 w-4 shrink-0" aria-hidden="true" />
            API and automation
          </TabsTrigger>
          <TabsTrigger
            value="data"
            className="justify-start gap-2 data-[state=active]:bg-accent data-[state=active]:text-accent-foreground data-[state=active]:shadow-none"
          >
            <Shield className="h-4 w-4 shrink-0" aria-hidden="true" />
            Data sources
          </TabsTrigger>
          <TabsTrigger
            value="retention"
            className="justify-start gap-2 data-[state=active]:bg-accent data-[state=active]:text-accent-foreground data-[state=active]:shadow-none"
          >
            <Archive className="h-4 w-4 shrink-0" aria-hidden="true" />
            Retention
          </TabsTrigger>
          <TabsTrigger
            value="diagnostics"
            className="justify-start gap-2 data-[state=active]:bg-accent data-[state=active]:text-accent-foreground data-[state=active]:shadow-none"
          >
            <Activity className="h-4 w-4 shrink-0" aria-hidden="true" />
            Diagnostics
          </TabsTrigger>
        </TabsList>

        <div className="min-w-0 max-w-3xl flex-1">
          <TabsContent value="setup" className="mt-0 space-y-4">
            <SetupChecklist onOpenSection={openSection} />
          </TabsContent>

          <TabsContent value="general" className="mt-0 space-y-4">
            <AppearanceSettings />
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
                      data-testid={`font-row-${f.id}`}
                      className="flex items-center justify-between p-3 rounded-md border"
                    >
                      <div>
                        <p className="text-sm font-medium">{f.family}</p>
                        <p className="text-xs text-muted-foreground uppercase">
                          {f.format}
                        </p>
                        <p
                          data-testid={`font-state-${f.id}`}
                          className="text-xs text-muted-foreground"
                        >
                          {f.state === "ready"
                            ? "Ready"
                            : f.state === "error"
                              ? "Download failed — will retry"
                              : "Downloading…"}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove ${f.family}`}
                        data-testid={`font-delete-${f.id}`}
                        onClick={async () => {
                          try {
                            await agent("delete_font", { id: f.id });
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
                  aria-label="Upload font file"
                  tabIndex={-1}
                  accept=".ttf,.otf,.woff,.woff2"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) uploadFont(f);
                    e.target.value = "";
                  }}
                />
                <Button
                  variant="outline"
                  data-testid="settings-font-upload"
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload className="h-4 w-4" />
                  Upload Font (TTF, OTF, WOFF2)
                </Button>
                {fontUploadError && (
                  <p role="alert" className="text-sm text-danger">
                    {fontUploadError}
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="background" className="mt-0 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Run in the background
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Keep the print queue alive without a window in the way.
                  Applies on desktop; on Android the notification controls this
                  instead.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <AndroidBackgroundControls
                  running={bgServiceRunning}
                  exempt={batteryExempt}
                  busy={bgBusy}
                  onRefresh={async () => {
                    const bg = await import("@/lib/android/background");
                    if (!bg.isAndroid()) return;
                    setBgBusy(true);
                    try {
                      setBgServiceRunning(
                        await bg.isBackgroundServiceRunning(),
                      );
                      setBatteryExempt(await bg.isBatteryExemptionGranted());
                    } finally {
                      setBgBusy(false);
                    }
                  }}
                  onRequestExemption={async () => {
                    const bg = await import("@/lib/android/background");
                    setBgBusy(true);
                    try {
                      await bg.requestBatteryExemption();
                      setBatteryExempt(await bg.isBatteryExemptionGranted());
                      toast.success("Battery setting updated");
                    } finally {
                      setBgBusy(false);
                    }
                  }}
                />
                {!isAndroidBackground() && (
                  <>
                    <div className="flex items-center gap-2">
                      <Switch
                        id="launch-at-startup"
                        data-testid="settings-launch-at-startup"
                        checked={launchAtStartup}
                        onCheckedChange={(v) =>
                          setBackgroundPref(
                            "launch_at_startup",
                            v,
                            setLaunchAtStartup,
                          )
                        }
                      />
                      <Label htmlFor="launch-at-startup">
                        Launch at startup
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        id="start-minimized"
                        data-testid="settings-start-minimized"
                        checked={startMinimized}
                        disabled={!launchAtStartup}
                        onCheckedChange={(v) =>
                          setBackgroundPref(
                            "start_minimized",
                            v,
                            setStartMinimized,
                          )
                        }
                      />
                      <Label htmlFor="start-minimized">
                        Start minimized in the notification area
                      </Label>
                    </div>
                    {!launchAtStartup && (
                      <p className="text-xs text-muted-foreground">
                        Start minimized needs launch at startup.
                      </p>
                    )}
                    <div className="flex items-center gap-2">
                      <Switch
                        id="minimize-to-tray"
                        data-testid="settings-minimize-to-tray"
                        checked={minimizeToTray}
                        onCheckedChange={(v) =>
                          setBackgroundPref(
                            "minimize_to_tray",
                            v,
                            setMinimizeToTray,
                          )
                        }
                      />
                      <Label htmlFor="minimize-to-tray">
                        Minimizing sends the app to the notification area
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        id="close-to-tray"
                        data-testid="settings-close-to-tray"
                        checked={closeToTray}
                        onCheckedChange={(v) =>
                          setBackgroundPref("close_to_tray", v, setCloseToTray)
                        }
                      />
                      <Label htmlFor="close-to-tray">
                        Closing keeps the app in the notification area
                      </Label>
                    </div>
                    {!closeToTray && (
                      <p className="text-xs text-warning">
                        Closing will quit the app and stop the print queue.
                      </p>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="share" className="mt-0 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Share Service</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1">
                  <Label htmlFor="share-url">Service URL</Label>
                  <div className="flex gap-2">
                    <Input
                      id="share-url"
                      placeholder="https://share.printninja.example"
                      value={shareUrl}
                      onChange={(e) => setShareUrl(e.target.value)}
                    />
                    <Button variant="outline" onClick={saveShareUrl}>
                      Save
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Leave empty to hide sharing features (V1 behaviour). No
                    database credentials are bundled in the app — the service
                    keeps its own database.
                  </p>
                </div>

                {!shareUser ? (
                  <div className="space-y-3 border-t pt-4">
                    <p className="text-sm font-medium">Sign in to publish</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label htmlFor="share-handle">Handle</Label>
                        <Input
                          id="share-handle"
                          placeholder="alice"
                          value={shareHandle}
                          onChange={(e) => setShareHandle(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="share-password">Password</Label>
                        <Input
                          id="share-password"
                          type="password"
                          value={sharePassword}
                          onChange={(e) => setSharePassword(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button onClick={doLogin} disabled={shareBusy}>
                        {shareBusy ? "…" : "Sign in"}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={doRegister}
                        disabled={shareBusy}
                      >
                        {shareBusy ? "…" : "Register"}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Handle: 1–32 chars, alphanumeric + _ -. Password ≥ 8
                      chars. Throttled 5/min per handle/IP.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3 border-t pt-4">
                    <div className="flex items-center justify-between">
                      <p className="text-sm">
                        Signed in as{" "}
                        <span className="font-medium">{shareUser.handle}</span>
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={doLogout}
                        disabled={shareBusy}
                      >
                        Sign out
                      </Button>
                    </div>
                    <ChangePasswordForm
                      busy={shareBusy}
                      setBusy={setShareBusy}
                    />
                  </div>
                )}
              </CardContent>
            </Card>
            <SyncStatusCard />
          </TabsContent>

          <TabsContent value="api" className="mt-0 space-y-4">
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
                    data-testid="settings-api-port"
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
                  <p className="text-xs text-warning">
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
                    aria-label="Trusted source"
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

          <TabsContent value="data" className="mt-0 space-y-4">
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
                    aria-invalid={!!domainsError}
                    aria-describedby={
                      domainsError ? "allowed-domains-error" : undefined
                    }
                    onChange={(e) => {
                      setAllowedDomains(e.target.value);
                      setDomainsError("");
                    }}
                    onBlur={() => void saveAllowedDomains(allowedDomains)}
                  />
                  {domainsError && (
                    <p
                      id="allowed-domains-error"
                      role="alert"
                      className="text-xs text-danger"
                    >
                      {domainsError}
                    </p>
                  )}
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

          <TabsContent value="retention" className="mt-0 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {t("settings_page.retention")}
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label htmlFor="retention-days">
                    Keep history for (days)
                  </Label>
                  <Input
                    id="retention-days"
                    type="number"
                    min="1"
                    value={retentionDays}
                    aria-invalid={!!retentionError}
                    aria-describedby={
                      retentionError ? "retention-days-error" : undefined
                    }
                    onChange={(e) => {
                      setRetentionDays(e.target.value);
                      setRetentionError("");
                    }}
                    onBlur={() =>
                      saveNumber(
                        "retention_days",
                        retentionDays,
                        1,
                        "Keep history for",
                        setRetentionError,
                      )
                    }
                  />
                  {retentionError && (
                    <p
                      id="retention-days-error"
                      role="alert"
                      className="text-xs text-danger"
                    >
                      {retentionError}
                    </p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="max-records">Max records</Label>
                  <Input
                    id="max-records"
                    type="number"
                    min="100"
                    value={maxRecords}
                    aria-invalid={!!maxError}
                    aria-describedby={
                      maxError ? "max-records-error" : undefined
                    }
                    onChange={(e) => {
                      setMaxRecords(e.target.value);
                      setMaxError("");
                    }}
                    onBlur={() =>
                      saveNumber(
                        "max_records",
                        maxRecords,
                        100,
                        "Max records",
                        setMaxError,
                      )
                    }
                  />
                  {maxError && (
                    <p
                      id="max-records-error"
                      role="alert"
                      className="text-xs text-danger"
                    >
                      {maxError}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Reset this PC</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Erases everything the app owns on this PC: templates and
                  versions, print history, printers, fonts and their files,
                  datasets, profiles, the sync state and every setting —
                  including the sign-in, so the app returns to the welcome
                  screen. The server keeps the account; signing back in pulls it
                  down again.
                </p>
                <Button
                  variant="destructive"
                  data-testid="settings-reset-database"
                  onClick={() => setShowResetDialog(true)}
                >
                  <Trash2 className="h-3 w-3 mr-2" />
                  Reset this PC…
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="diagnostics" className="mt-0 space-y-4">
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
        </div>
      </Tabs>

      {/* Clearing the allowlist means any domain can feed data URLs. */}
      <Dialog open={allowAllOpen} onOpenChange={setAllowAllOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Allow data from any domain?</DialogTitle>
            <DialogDescription>
              An empty list allows every domain. Live data URLs could then pull
              content from anywhere — keep at least your own hosts listed unless
              you mean it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAllowAllOpen(false)}>
              Keep the list
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                void (async () => {
                  await writeSetting("allowed_domains", "");
                  lastSavedDomains.current = "";
                  setAllowAllOpen(false);
                  toast.success("Allowed domains cleared — any domain allowed");
                })();
              }}
            >
              Allow all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Full-reset confirmation: the wipe cannot be undone. */}
      <Dialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Erase everything on this PC?</DialogTitle>
            <DialogDescription>
              Templates, print history, printers, fonts, datasets, profiles and
              all settings will be permanently deleted from this PC. The server
              keeps the account — sign back in to pull it down again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowResetDialog(false)}
              disabled={resetBusy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={resetBusy}
              onClick={() => {
                void (async () => {
                  setResetBusy(true);
                  try {
                    const report = await agent("reset_database", {});
                    toast.success(
                      `Cleared ${report.templates} templates, ${report.print_jobs} jobs and ${report.fonts} fonts`,
                    );
                    window.location.reload();
                  } catch (e) {
                    toast.error(`Reset failed: ${e}`);
                  } finally {
                    setResetBusy(false);
                    setShowResetDialog(false);
                  }
                })();
              }}
            >
              {resetBusy ? "Erasing…" : "Erase everything"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Version footer */}
      <div className="flex items-center justify-center gap-2 pt-4 text-xs text-muted-foreground border-t">
        <Info className="h-3 w-3" />
        <span>PrintNinja {appVersion ? `v${appVersion}` : "v2.2.0"}</span>
        <span className="opacity-50">·</span>
        <span className="hidden sm:inline">com.printninja.desktop</span>
      </div>
    </div>
  );
}
