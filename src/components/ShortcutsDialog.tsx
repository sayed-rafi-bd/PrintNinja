import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NAV_ITEMS } from "@/lib/shell/nav";

function Keys({ keys }: { keys: string[] }) {
  const { t } = useTranslation();
  return (
    <span className="flex items-center gap-1">
      {keys.map((k, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && (
            <span className="text-xs text-muted-foreground">
              {t("shell.then")}
            </span>
          )}
          {/* Meaningless on touch: hide on coarse pointers. */}
          <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs [@media(pointer:coarse)]:hidden">
            {k}
          </kbd>
        </span>
      ))}
    </span>
  );
}

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation();
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = isMac ? "⌘" : "Ctrl";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("shell.shortcuts")}</DialogTitle>
          <DialogDescription>{t("shell.shortcuts_hint")}</DialogDescription>
        </DialogHeader>
        <dl className="divide-y text-sm">
          <div className="flex items-center justify-between py-2">
            <dt>{t("shell.open_search")}</dt>
            <dd>
              <Keys keys={[`${mod}+K`]} />
            </dd>
          </div>
          <div className="flex items-center justify-between py-2">
            <dt>{t("shell.show_shortcuts")}</dt>
            <dd>
              <Keys keys={["?"]} />
            </dd>
          </div>
          {NAV_ITEMS.map((item) => (
            <div
              key={item.path}
              className="flex items-center justify-between py-2"
            >
              <dt>{t("shell.go_to", { page: t(item.labelKey) })}</dt>
              <dd>
                <Keys keys={["G", item.shortcut.toUpperCase()]} />
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
