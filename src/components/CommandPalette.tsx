import { Command } from "cmdk";
import { useEffect, useState } from "react";
import {
  FilePlus,
  History,
  Printer as PrintIcon,
  Printer,
  Search,
  Settings2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { NAV_ITEMS } from "@/lib/shell/nav";
import { agent } from "@/lib/agent/commands";
import type { HistoryJob, PrinterRow } from "@/lib/agent/types";
import type { SettingsSection } from "@/lib/setup/checklist";

/** Settings sections, in tab order, reusing the Settings page labels. */
const SETTING_SECTIONS: SettingsSection[] = [
  "setup",
  "general",
  "background",
  "share",
  "api",
  "data",
  "retention",
  "diagnostics",
];

const SECTION_LABEL_KEYS: Record<SettingsSection, string> = {
  setup: "settings_page.section_setup",
  general: "settings_page.section_general",
  background: "settings_page.section_background",
  share: "settings_page.section_share",
  api: "settings_page.section_api",
  data: "settings_page.section_data",
  retention: "settings_page.section_retention",
  diagnostics: "settings_page.section_diagnostics",
};

const MAX_JOBS = 7;
const MAX_PRINTERS = 20;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (path: string) => void;
  onReprintLast: () => void;
  onReprintJob: (id: number) => void;
}

const ITEM =
  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground [@media(pointer:coarse)]:min-h-11";
const GROUP =
  "px-1 py-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground";

export function CommandPalette({
  open,
  onOpenChange,
  onNavigate,
  onReprintLast,
  onReprintJob,
}: Props) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<
    Array<{ id: number; name: string }>
  >([]);
  const [printers, setPrinters] = useState<PrinterRow[]>([]);
  const [jobs, setJobs] = useState<HistoryJob[]>([]);

  // Templates, printers and jobs live in the desktop database, so load them
  // when the palette opens. Every list is optional: one failing call must
  // not hide the others.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    agent("list_templates", {})
      .then((rows) => {
        if (!cancelled) setTemplates(rows);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    agent("list_printers", {})
      .then((rows) => {
        if (!cancelled) setPrinters(rows);
      })
      .catch(() => {
        if (!cancelled) setPrinters([]);
      });
    agent("list_jobs", {})
      .then((rows) => {
        if (!cancelled) {
          setJobs([...rows].sort((a, b) => b.id - a.id).slice(0, MAX_JOBS));
        }
      })
      .catch(() => {
        if (!cancelled) setJobs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[20%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">{t("shell.search")}</DialogTitle>
        <DialogDescription className="sr-only">
          {t("shell.search_hint")}
        </DialogDescription>
        <Command label={t("shell.search")} loop>
          <div className="flex items-center gap-2 border-b px-3">
            <Search
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <Command.Input
              autoFocus
              placeholder={t("shell.search_placeholder")}
              className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <Command.List className="max-h-80 overflow-y-auto p-1">
            <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t("shell.no_results")}
            </Command.Empty>
            <Command.Group heading={t("shell.group_pages")} className={GROUP}>
              {NAV_ITEMS.map((item) => (
                <Command.Item
                  key={item.path}
                  value={`page ${t(item.labelKey)}`}
                  onSelect={() => run(() => onNavigate(item.path))}
                  className={ITEM}
                >
                  <item.icon className="h-4 w-4" aria-hidden="true" />
                  <span className="flex-1">{t(item.labelKey)}</span>
                  {/* Letter shortcuts are meaningless on touch: hide on coarse pointers. */}
                  <kbd className="font-mono text-xs text-muted-foreground [@media(pointer:coarse)]:hidden">
                    G {item.shortcut.toUpperCase()}
                  </kbd>
                </Command.Item>
              ))}
            </Command.Group>
            <Command.Group
              heading={t("shell.group_settings")}
              className={GROUP}
            >
              {SETTING_SECTIONS.map((section) => (
                <Command.Item
                  key={section}
                  value={`settings ${t(SECTION_LABEL_KEYS[section])}`}
                  onSelect={() =>
                    run(() => onNavigate(`/settings?section=${section}`))
                  }
                  className={ITEM}
                >
                  <Settings2 className="h-4 w-4" aria-hidden="true" />
                  <span className="flex-1">
                    {t(SECTION_LABEL_KEYS[section])}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
            <Command.Group heading={t("shell.group_actions")} className={GROUP}>
              <Command.Item
                value="action new template"
                onSelect={() => run(() => onNavigate("/"))}
                className={ITEM}
              >
                <FilePlus className="h-4 w-4" aria-hidden="true" />
                {t("shell.new_template")}
              </Command.Item>
              <Command.Item
                value="action reprint last job"
                onSelect={() => run(onReprintLast)}
                className={ITEM}
              >
                <PrintIcon className="h-4 w-4" aria-hidden="true" />
                {t("shell.reprint_last")}
              </Command.Item>
            </Command.Group>
            {jobs.length > 0 && (
              <Command.Group heading={t("shell.group_jobs")} className={GROUP}>
                {jobs.map((job) => (
                  <Command.Item
                    key={job.id}
                    value={`job ${job.id} ${t(`status.${job.status}`)}`}
                    onSelect={() => run(() => onReprintJob(job.id))}
                    className={ITEM}
                  >
                    <History className="h-4 w-4" aria-hidden="true" />
                    <span className="flex-1 truncate">
                      {t("shell.reprint_job", { id: job.id })}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t(`status.${job.status}`)}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            {printers.slice(0, MAX_PRINTERS).length > 0 && (
              <Command.Group
                heading={t("shell.group_printers")}
                className={GROUP}
              >
                {printers.slice(0, MAX_PRINTERS).map((p) => (
                  <Command.Item
                    key={p.id}
                    value={`printer ${p.name} ${p.address}`}
                    onSelect={() => run(() => onNavigate("/printers"))}
                    className={ITEM}
                  >
                    <Printer className="h-4 w-4" aria-hidden="true" />
                    <span className="flex-1 truncate">{p.name}</span>
                    <span className="max-w-40 truncate font-mono text-xs text-muted-foreground">
                      {p.address}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            {templates.length > 0 && (
              <Command.Group
                heading={t("shell.group_templates")}
                className={GROUP}
              >
                {templates.slice(0, 50).map((tpl) => (
                  <Command.Item
                    key={tpl.id}
                    value={`template ${tpl.name} ${tpl.id}`}
                    onSelect={() =>
                      run(() => onNavigate(`/template/${tpl.id}`))
                    }
                    className={ITEM}
                  >
                    <span className="truncate">{tpl.name}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
