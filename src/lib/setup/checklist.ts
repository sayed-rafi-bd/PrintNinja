/** Admin setup checklist. Pure model here; the Settings section supplies live data. */

export type SettingsSection =
  | "general"
  | "background"
  | "share"
  | "api"
  | "data"
  | "retention"
  | "diagnostics"
  | "setup";

export interface ChecklistInput {
  /** Counts are null when they cannot be read (browser preview, backend error). */
  printers: number | null;
  templates: number | null;
  jobs: number | null;
  shareConfigured: boolean | null;
  apiRunning: boolean | null;
  retentionReviewed: boolean | null;
}

export type ChecklistTarget =
  | { kind: "page"; path: string }
  | { kind: "section"; section: SettingsSection };

export interface ChecklistItem {
  id: "printer" | "template" | "test_print" | "share" | "api" | "retention";
  title: string;
  description: string;
  required: boolean;
  /** true = done, false = to do, null = could not be checked. */
  done: boolean | null;
  detail?: string;
  action: string;
  target: ChecklistTarget;
}

const count = (n: number | null): boolean | null => (n === null ? null : n > 0);

type T = (key: string, params?: Record<string, string | number>) => string;

export function buildChecklist(i: ChecklistInput, t: T): ChecklistItem[] {
  const plural = (n: number, oneKey: string, manyKey: string) =>
    t("checklist.detail_count", {
      count: n,
      unit: t(n === 1 ? oneKey : manyKey),
    });
  return [
    {
      id: "printer",
      title: t("checklist.printer_title"),
      description: t("checklist.printer_desc"),
      required: true,
      done: count(i.printers),
      detail: i.printers
        ? `${plural(i.printers, "checklist.unit_printer", "checklist.unit_printers")} ${t("checklist.detail_added")}`
        : undefined,
      action: t("checklist.printer_action"),
      target: { kind: "page", path: "/printers" },
    },
    {
      id: "template",
      title: t("checklist.template_title"),
      description: t("checklist.template_desc"),
      required: true,
      done: count(i.templates),
      detail: i.templates
        ? `${plural(i.templates, "checklist.unit_template", "checklist.unit_templates")} ${t("checklist.detail_available")}`
        : undefined,
      action: t("checklist.template_action"),
      target: { kind: "page", path: "/templates" },
    },
    {
      id: "test_print",
      title: t("checklist.test_title"),
      description: t("checklist.test_desc"),
      required: true,
      done: count(i.jobs),
      detail: i.jobs
        ? `${plural(i.jobs, "checklist.unit_job", "checklist.unit_jobs")} ${t("checklist.detail_history")}`
        : undefined,
      action: t("checklist.test_action"),
      target: { kind: "page", path: "/printers" },
    },
    {
      id: "retention",
      title: t("checklist.retention_title"),
      description: t("checklist.retention_desc"),
      required: false,
      done: i.retentionReviewed,
      action: t("checklist.retention_action"),
      target: { kind: "section", section: "retention" },
    },
    {
      id: "api",
      title: t("checklist.api_title"),
      description: t("checklist.api_desc"),
      required: false,
      done: i.apiRunning,
      action: t("checklist.api_action"),
      target: { kind: "section", section: "api" },
    },
    {
      id: "share",
      title: t("checklist.share_title"),
      description: t("checklist.share_desc"),
      required: false,
      done: i.shareConfigured,
      action: t("checklist.share_action"),
      target: { kind: "section", section: "share" },
    },
  ];
}

export function summarize(items: ChecklistItem[]) {
  const required = items.filter((x) => x.required);
  const requiredDone = required.filter((x) => x.done === true).length;
  const unknown = required.some((x) => x.done === null);
  return {
    requiredDone,
    requiredTotal: required.length,
    complete: !unknown && requiredDone === required.length,
    unknown,
  };
}

const SECTIONS: SettingsSection[] = [
  "setup",
  "general",
  "background",
  "share",
  "api",
  "data",
  "retention",
  "diagnostics",
];

/** Reads `?section=` safely; anything unknown opens General. */
export function parseSection(value: string | null): SettingsSection {
  return (SECTIONS as string[]).includes(value ?? "")
    ? (value as SettingsSection)
    : "general";
}
