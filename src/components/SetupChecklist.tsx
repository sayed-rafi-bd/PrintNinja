import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { readSetting } from "@/lib/settings";
import * as share from "@/lib/share/client";
import {
  buildChecklist,
  summarize,
  type ChecklistInput,
  type SettingsSection,
} from "@/lib/setup/checklist";
import { tauriInvoke } from "@/lib/tauriGuard";
import { agent } from "@/lib/agent/commands";

const EMPTY: ChecklistInput = {
  printers: null,
  templates: null,
  jobs: null,
  shareConfigured: null,
  apiRunning: null,
  retentionReviewed: null,
};

async function countOf(cmd: string): Promise<number | null> {
  try {
    const rows = await tauriInvoke<unknown>(cmd);
    return Array.isArray(rows) ? rows.length : null;
  } catch {
    return null;
  }
}

async function loadStatus(): Promise<ChecklistInput> {
  const [printers, templates, jobs, retention, url] = await Promise.all([
    countOf("list_printers"),
    countOf("list_templates"),
    countOf("list_jobs"),
    readSetting("retention_days").catch(() => null),
    share.getServiceUrl().catch(() => null),
  ]);
  let apiRunning: boolean | null = null;
  try {
    // Static command: typed. countOf above keeps the raw invoke on
    // purpose — its command name is dynamic.
    const status = await agent("get_api_status", {});
    apiRunning = status ? Boolean(status.running) : null;
  } catch {
    apiRunning = null;
  }
  const native = printers !== null || templates !== null || jobs !== null;
  return {
    printers,
    templates,
    jobs,
    shareConfigured: Boolean(url),
    apiRunning,
    // Retention and share can be read in the browser preview too.
    retentionReviewed: native || retention !== null ? retention !== null : null,
  };
}

export function SetupChecklist({
  onOpenSection,
}: {
  onOpenSection: (s: SettingsSection) => void;
}) {
  const [status, setStatus] = useState<ChecklistInput>(EMPTY);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadStatus().then((s) => {
      if (!cancelled) {
        setStatus(s);
        setLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const items = buildChecklist(status);
  const sum = summarize(items);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Setup checklist</CardTitle>
        <p role="status" className="text-sm text-muted-foreground">
          {!loaded
            ? "Checking this workstation…"
            : sum.unknown
              ? "Some steps can't be checked in the browser preview. Open the desktop app to see their status."
              : sum.complete
                ? "All required steps are done."
                : `${sum.requiredDone} of ${sum.requiredTotal} required steps done.`}
        </p>
      </CardHeader>
      <CardContent>
        <ol className="divide-y rounded-md border">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-4"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {item.title}
                  {!item.required && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      Optional
                    </span>
                  )}
                </p>
                <p className="text-sm text-muted-foreground">
                  {item.description}
                  {item.detail ? ` ${item.detail}.` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {loaded && item.done === true && (
                  <StatusBadge status="success" label="Done" />
                )}
                {loaded && item.done === false && item.required && (
                  <StatusBadge status="queued" label="To do" />
                )}
                {loaded && item.done === null && (
                  <span className="text-xs text-muted-foreground">
                    Not checked
                  </span>
                )}
                {item.target.kind === "page" ? (
                  <Button asChild variant="outline" size="sm">
                    <Link to={item.target.path}>{item.action}</Link>
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      item.target.kind === "section" &&
                      onOpenSection(item.target.section)
                    }
                  >
                    {item.action}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
