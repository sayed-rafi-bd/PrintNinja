import { describeError } from "@/lib/errors";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { agent } from "@/lib/agent/commands";
import type { ApiStatus } from "@/lib/agent/types";
import { isWebMode, readSetting } from "@/lib/settings";
import { cn } from "@/lib/utils";

interface Endpoint {
  method: "GET" | "POST" | "DELETE";
  path: string;
  summaryKey: string;
  descriptionKey: string;
  /** Needs a real-world side effect when executed. */
  mutating: boolean;
  needsId?: boolean;
  hasBody?: boolean;
}

/**
 * The local API surface the explorer can call. Mirrors
 * `src-tauri/src/api/openapi.rs` — the explorer fetches the live spec for
 * its version banner, but this static list drives the UI so the page also
 * renders when the server is stopped.
 */
const ENDPOINTS: Endpoint[] = [
  {
    method: "GET",
    path: "/v1/health",
    summaryKey: "explorer.endpoint_health",
    descriptionKey: "explorer.endpoint_health_desc",
    mutating: false,
  },
  {
    method: "GET",
    path: "/v1/printers",
    summaryKey: "explorer.endpoint_printers",
    descriptionKey: "explorer.endpoint_printers_desc",
    mutating: false,
  },
  {
    method: "GET",
    path: "/v1/templates",
    summaryKey: "explorer.endpoint_templates",
    descriptionKey: "explorer.endpoint_templates_desc",
    mutating: false,
  },
  {
    method: "GET",
    path: "/v1/jobs",
    summaryKey: "explorer.endpoint_jobs",
    descriptionKey: "explorer.endpoint_jobs_desc",
    mutating: false,
  },
  {
    method: "GET",
    path: "/v1/jobs/{id}",
    summaryKey: "explorer.endpoint_job",
    descriptionKey: "explorer.endpoint_job_desc",
    mutating: false,
    needsId: true,
  },
  {
    method: "GET",
    path: "/v1/metrics",
    summaryKey: "explorer.endpoint_metrics",
    descriptionKey: "explorer.endpoint_metrics_desc",
    mutating: false,
  },
  {
    method: "GET",
    path: "/v1/metrics/prometheus",
    summaryKey: "explorer.endpoint_prom",
    descriptionKey: "explorer.endpoint_prom_desc",
    mutating: false,
  },
  {
    method: "GET",
    path: "/v1/openapi.json",
    summaryKey: "explorer.endpoint_openapi",
    descriptionKey: "explorer.endpoint_openapi_desc",
    mutating: false,
  },
  {
    method: "POST",
    path: "/v1/jobs/{id}/retry",
    summaryKey: "explorer.endpoint_retry",
    descriptionKey: "explorer.endpoint_retry_desc",
    mutating: true,
    needsId: true,
  },
  {
    method: "DELETE",
    path: "/v1/jobs/{id}",
    summaryKey: "explorer.endpoint_cancel",
    descriptionKey: "explorer.endpoint_cancel_desc",
    mutating: true,
    needsId: true,
  },
  {
    method: "POST",
    path: "/v1/print",
    summaryKey: "explorer.endpoint_print",
    descriptionKey: "explorer.endpoint_print_desc",
    mutating: true,
    hasBody: true,
  },
];

const PRINT_BODY_EXAMPLE = `{
  "template": "Receipt",
  "printer": "Front Desk",
  "data": { "order": 1042 }
}`;

const PRINT_URL_EXAMPLE = `{
  "template": "Receipt",
  "printer": "Front Desk",
  "data_url": "https://pos.local/ticket/1042"
}`;

/** Loopback is always reachable; 0.0.0.0 (LAN mode) is not a destination. */
function baseUrl(status: ApiStatus): string {
  return `http://127.0.0.1:${status.port}`;
}

/** Method badges reuse status semantics: safe, side-effecting, destructive. */
function methodVariant(
  method: Endpoint["method"],
): "success" | "warning" | "destructive" {
  switch (method) {
    case "GET":
      return "success";
    case "POST":
      return "warning";
    case "DELETE":
      return "destructive";
  }
}

export function ApiExplorerPage() {
  const { t } = useTranslation();
  const webMode = isWebMode();
  const [status, setStatus] = useState<ApiStatus | null>(null);
  const [specVersion, setSpecVersion] = useState<string | null>(null);
  const [selected, setSelected] = useState<Endpoint>(ENDPOINTS[0]);
  const [jobId, setJobId] = useState("");
  const [body, setBody] = useState(PRINT_BODY_EXAMPLE);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [response, setResponse] = useState<{
    status: number;
    text: string;
  } | null>(null);

  const loadStatus = useCallback(async () => {
    if (isWebMode()) return;
    try {
      setStatus(await agent("get_api_status", {}));
    } catch {
      /* backend unavailable */
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Version banner comes from the live spec, so the explorer visibly
  // tracks the server it talks to.
  useEffect(() => {
    if (!status?.running) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${baseUrl(status)}/v1/openapi.json`);
        if (!res.ok) return;
        const spec = (await res.json()) as { info?: { version?: string } };
        if (!cancelled && spec.info?.version) setSpecVersion(spec.info.version);
      } catch {
        /* server stopped mid-load */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status]);

  const resolvedPath = useMemo(
    () => selected.path.replace("{id}", jobId.trim() || "{id}"),
    [selected, jobId],
  );

  const canSend =
    !busy && !!status?.running && (!selected.needsId || jobId.trim() !== "");

  const send = async () => {
    if (!status?.running) return;
    if (selected.needsId && !jobId.trim()) {
      toast.error(t("explorer.toast_job_id_required"));
      return;
    }
    let parsed: unknown = undefined;
    if (selected.hasBody) {
      try {
        parsed = JSON.parse(body);
      } catch {
        toast.error(t("explorer.toast_bad_json"));
        return;
      }
    }
    setBusy(true);
    setResponse(null);
    try {
      const url = `${baseUrl(status)}${selected.path.replace("{id}", jobId.trim())}`;
      const headers: Record<string, string> = {};
      let payload: string | undefined;
      if (selected.hasBody) {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(parsed);
        if (idempotencyKey.trim())
          headers["Idempotency-Key"] = idempotencyKey.trim();
      }
      const res = await fetch(url, {
        method: selected.method,
        headers,
        body: payload,
      });
      const text = await res.text();
      setResponse({ status: res.status, text });
    } catch (e) {
      toast.error(
        t("explorer.toast_request_failed", { error: describeError(e) }),
      );
    } finally {
      setBusy(false);
    }
  };

  const startServer = async () => {
    setStarting(true);
    try {
      const port = Number((await readSetting("api_port")) || "17717");
      const lan = (await readSetting("api_lan_access")) === "true";
      await agent("start_api_server", { port, lan_access: lan });
      toast.success(t("explorer.toast_started"));
      await loadStatus();
    } catch (e) {
      toast.error(
        t("settings_page.toast_api_start_failed", { error: describeError(e) }),
      );
    } finally {
      setStarting(false);
    }
  };

  // The browser preview has no Tauri backend and no local server to call.
  if (webMode) {
    return (
      <div className="space-y-4">
        <PageHeader
          title={t("nav.api_explorer")}
          description={t("pages.api_explorer")}
        />
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              {t("explorer.web_notice")}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("nav.api_explorer")}
        description={t("pages.api_explorer")}
      >
        <div className="flex items-center gap-2">
          {specVersion && (
            <Badge variant="outline" data-testid="api-explorer-spec-version">
              {t("explorer.spec_version", { version: specVersion })}
            </Badge>
          )}
          <Badge variant={status?.running ? "success" : "secondary"}>
            {status?.running
              ? `${status.address}:${status.port}`
              : t("explorer.stopped")}
          </Badge>
        </div>
      </PageHeader>

      {!status?.running ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("explorer.not_running_title")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("explorer.not_running_hint")}
            </p>
            <div className="flex gap-2">
              <Button onClick={startServer} disabled={starting}>
                {starting ? t("explorer.starting") : t("explorer.start_server")}
              </Button>
              <Button variant="outline" asChild>
                <Link to="/settings?section=api">
                  {t("explorer.open_settings")}
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          {/* Live-spec browser: every local endpoint, grouped by safety. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t("explorer.endpoints")}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  live: {baseUrl(status)}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {ENDPOINTS.map((ep) => (
                <button
                  key={`${ep.method} ${ep.path}`}
                  type="button"
                  onClick={() => {
                    setSelected(ep);
                    setResponse(null);
                  }}
                  aria-pressed={selected === ep}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent",
                    selected === ep && "bg-accent",
                  )}
                >
                  <Badge
                    variant={methodVariant(ep.method)}
                    className="w-14 shrink-0 justify-center px-1 font-mono text-[10px]"
                  >
                    {ep.method}
                  </Badge>
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-xs">
                      {ep.path}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {t(ep.summaryKey)}
                    </span>
                  </span>
                </button>
              ))}
              <a
                href={`${baseUrl(status)}/v1/openapi.json`}
                target="_blank"
                rel="noreferrer"
                className="block px-2 pt-2 text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                {t("explorer.raw_link")}
              </a>
            </CardContent>
          </Card>

          {/* Try-it-out console. */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Badge
                  variant={methodVariant(selected.method)}
                  className="font-mono text-[11px]"
                >
                  {selected.method}
                </Badge>
                <span className="font-mono text-sm">{resolvedPath}</span>
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                {t(selected.summaryKey)} — {t(selected.descriptionKey)}
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {selected.method === "POST" && selected.path === "/v1/print" && (
                <p
                  role="alert"
                  className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning"
                >
                  {t("explorer.print_warning")}
                </p>
              )}
              {selected.mutating && selected.path !== "/v1/print" && (
                <p
                  role="alert"
                  className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning"
                >
                  {t("explorer.mutate_warning")}
                </p>
              )}

              {selected.needsId && (
                <div className="space-y-1">
                  <Label htmlFor="api-explorer-id">
                    {t("explorer.job_id")}
                  </Label>
                  <Input
                    id="api-explorer-id"
                    data-testid="api-explorer-job-id"
                    inputMode="numeric"
                    placeholder={t("explorer.job_id_example")}
                    value={jobId}
                    onChange={(e) => setJobId(e.target.value)}
                  />
                </div>
              )}

              {selected.hasBody && (
                <>
                  {selected.path === "/v1/print" && (
                    <div
                      role="group"
                      aria-label={t("explorer.fill_example_aria")}
                      className="flex flex-wrap gap-2"
                    >
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setBody(PRINT_BODY_EXAMPLE)}
                      >
                        {t("explorer.example_inline")}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setBody(PRINT_URL_EXAMPLE)}
                      >
                        {t("explorer.example_url")}
                      </Button>
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label htmlFor="api-explorer-body">
                      {t("explorer.body_label")}
                    </Label>
                    <Textarea
                      id="api-explorer-body"
                      data-testid="api-explorer-body"
                      rows={8}
                      className="font-mono text-xs"
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                    />
                    {selected.path === "/v1/print" && (
                      <p className="text-xs text-muted-foreground">
                        {t("explorer.body_hint")}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="api-explorer-idempotency">
                      {t("explorer.idem_label")}
                    </Label>
                    <Input
                      id="api-explorer-idempotency"
                      data-testid="api-explorer-idempotency"
                      placeholder={t("explorer.idem_hint")}
                      value={idempotencyKey}
                      onChange={(e) => setIdempotencyKey(e.target.value)}
                    />
                  </div>
                </>
              )}

              <Button
                onClick={send}
                disabled={!canSend}
                data-testid="api-explorer-send"
              >
                {busy
                  ? t("explorer.sending")
                  : t("explorer.send", {
                      method: selected.method,
                      path: resolvedPath,
                    })}
              </Button>

              {response && (
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    {t("explorer.response")}
                    <Badge
                      variant={
                        response.status < 400 ? "success" : "destructive"
                      }
                      className="ml-2"
                    >
                      {response.status}
                    </Badge>
                  </p>
                  <pre
                    data-testid="api-explorer-response"
                    className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs"
                    tabIndex={0}
                  >
                    {formatResponse(response.text)}
                  </pre>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

/** Pretty-print JSON bodies; pass anything else through untouched. */
function formatResponse(text: string): string {
  if (!text) return "(empty body — e.g. a 204 cancel)";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
