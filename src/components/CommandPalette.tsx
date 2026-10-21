import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { FilePlus, Printer as PrintIcon, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { NAV_ITEMS } from "@/lib/shell/nav";
import { agent } from "@/lib/agent/commands";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (path: string) => void;
  onReprintLast: () => void;
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
}: Props) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<
    Array<{ id: number; name: string }>
  >([]);

  // Templates live in the desktop database, so load them when the palette opens.
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
                  <kbd className="font-mono text-xs text-muted-foreground">
                    G {item.shortcut.toUpperCase()}
                  </kbd>
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
