/** Admin setup checklist. Pure model here; the Settings section supplies live data. */

export type SettingsSection = "general" | "share" | "api" | "data" | "retention" | "diagnostics" | "setup";

export interface ChecklistInput {
  /** Counts are null when they cannot be read (browser preview, backend error). */
  printers: number | null;
  templates: number | null;
  jobs: number | null;
  shareConfigured: boolean | null;
  apiRunning: boolean | null;
  retentionReviewed: boolean | null;
}

export type ChecklistTarget = { kind: "page"; path: string } | { kind: "section"; section: SettingsSection };

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
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function buildChecklist(i: ChecklistInput): ChecklistItem[] {
  return [
    {
      id: "printer",
      title: "Add a printer",
      description: "Network, USB, Bluetooth, or a system printer.",
      required: true,
      done: count(i.printers),
      detail: i.printers ? plural(i.printers, "printer", "printers") + " added" : undefined,
      action: "Open Printers",
      target: { kind: "page", path: "/printers" },
    },
    {
      id: "template",
      title: "Make a template available",
      description: "Create one in the Designer, or save one from the Community library.",
      required: true,
      done: count(i.templates),
      detail: i.templates ? plural(i.templates, "template", "templates") + " available" : undefined,
      action: "Open Templates",
      target: { kind: "page", path: "/templates" },
    },
    {
      id: "test_print",
      title: "Send a test print",
      description: "Confirms the printer, template, and paper work together.",
      required: true,
      done: count(i.jobs),
      detail: i.jobs ? plural(i.jobs, "job", "jobs") + " in History" : undefined,
      action: "Open Printers",
      target: { kind: "page", path: "/printers" },
    },
    {
      id: "retention",
      title: "Review history retention",
      description: "Choose how long print history is kept.",
      required: false,
      done: i.retentionReviewed,
      action: "Open Retention",
      target: { kind: "section", section: "retention" },
    },
    {
      id: "api",
      title: "Turn on the REST API",
      description: "Only needed if other systems print through PrintNinja.",
      required: false,
      done: i.apiRunning,
      action: "Open API settings",
      target: { kind: "section", section: "api" },
    },
    {
      id: "share",
      title: "Connect the share service",
      description: "Only needed to publish templates or use the Community library.",
      required: false,
      done: i.shareConfigured,
      action: "Open Share",
      target: { kind: "section", section: "share" },
    },
  ];
}

export function summarize(items: ChecklistItem[]) {
  const required = items.filter((x) => x.required);
  const requiredDone = required.filter((x) => x.done === true).length;
  const unknown = required.some((x) => x.done === null);
  return { requiredDone, requiredTotal: required.length, complete: !unknown && requiredDone === required.length, unknown };
}

const SECTIONS: SettingsSection[] = ["setup", "general", "share", "api", "data", "retention", "diagnostics"];

/** Reads `?section=` safely; anything unknown opens General. */
export function parseSection(value: string | null): SettingsSection {
  return (SECTIONS as string[]).includes(value ?? "") ? (value as SettingsSection) : "general";
}
