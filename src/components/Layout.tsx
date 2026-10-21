import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ChevronRight, CircleHelp, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AppLogo } from "@/components/AppLogo";
import { CommandPalette } from "@/components/CommandPalette";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import type { HistoryJob } from "@/lib/store/historyStore";
import { NAV_GROUPS, NAV_ITEMS, isActivePath } from "@/lib/shell/nav";
import { useGlobalShortcuts } from "@/lib/shell/useGlobalShortcuts";
import { useShareStatus } from "@/lib/shell/useShareStatus";
import { useSyncStatus } from "@/lib/sync/useSyncStatus";
import { useAdoption } from "@/lib/sync/useAdoption";
import { usePrefs } from "@/lib/prefs/PrefsProvider";
import { agent } from "@/lib/agent/commands";
import { cn } from "@/lib/utils";

function ShareIndicator() {
  const { t } = useTranslation();
  const status = useShareStatus();
  const sync = useSyncStatus();
  if (status.state === "unconfigured") return null;
  if (status.state === "online") {
    // One wrapper carries the test id (registry: exactly once in src/);
    // the badge inside reflects the sync state.
    let title: string;
    let badge: ReactNode;
    let to: string | null = null;
    if (sync.state === "conflict") {
      title = t("shell.sync_conflict");
      badge = <StatusBadge status="conflict" />;
      to = "/templates";
    } else if (sync.state === "syncing") {
      title = t("shell.sync_syncing");
      badge = <StatusBadge status="syncing" />;
    } else if (sync.state === "pending" || sync.pending > 0) {
      title = t("shell.sync_pending", { count: sync.pending });
      badge = (
        <StatusBadge
          status="pending"
          label={t("shell.sync_pending", { count: sync.pending })}
        />
      );
    } else if (sync.state === "offline") {
      title = t("shell.share_offline");
      badge = <StatusBadge status="offline" />;
      to = "/settings";
    } else {
      title = sync.lastPullAt
        ? t("shell.sync_synced", { time: sync.lastPullAt })
        : t("shell.share_online", { handle: status.handle });
      badge = (
        <StatusBadge
          status="synced"
          label={status.handle || t("status.online")}
        />
      );
    }
    const inner = <span title={title}>{badge}</span>;
    return (
      <span data-testid="sync-chip">
        {to ? <Link to={to}>{inner}</Link> : inner}
      </span>
    );
  }
  if (status.state === "offline") {
    return (
      <Link to="/settings" title={t("shell.share_offline")}>
        <StatusBadge status="offline" label={t("shell.share_offline")} />
      </Link>
    );
  }
  return (
    <Link
      to="/settings"
      className="text-xs text-muted-foreground underline-offset-2 hover:underline"
    >
      {t("shell.share_signed_out")}
    </Link>
  );
}

/** Banner over the content while the gate is open but the server is down. */
function OfflineBanner() {
  const { t } = useTranslation();
  const status = useShareStatus();
  if (status.state !== "offline") return null;
  return (
    <p
      data-testid="offline-banner"
      role="status"
      className="border-b border-warning/30 bg-warning-soft px-3 py-1.5 text-center text-xs text-warning"
    >
      {t("shell.offline_banner")}
    </p>
  );
}

/**
 * First sync on a migrated install (question 18): local-only templates
 * wait for one decision instead of uploading silently. Confirming pushes
 * them private; declining leaves them for the normal schedule.
 */
function AdoptionDialog() {
  const { pending, rows, busy, confirm, decline } = useAdoption();
  const [open, setOpen] = useState(pending);
  useEffect(() => {
    if (pending) setOpen(true);
  }, [pending]);
  if (!pending) return null;
  const names = rows.map((r) => r.name);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          void decline();
        }
        setOpen(o);
      }}
      title={`Back up ${rows.length === 1 ? "1 template" : `${rows.length} templates`} to the server?`}
      description={
        <>
          <p>
            These templates live only on this PC. Backing them up stores a
            private copy on the server.
          </p>
          <ul className="mt-2 list-disc pl-5">
            {names.slice(0, 8).map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          {names.length > 8 && <p>…and {names.length - 8} more.</p>}
        </>
      }
      confirmLabel={busy ? "Backing up…" : "Back up"}
      cancelLabel="Not now"
      busy={busy}
      onConfirm={async () => {
        // On success the hook clears pending and the dialog unmounts;
        // on failure it stays open with a toast.
        try {
          await confirm();
        } catch (e) {
          toast.error(e instanceof Error ? e.message : String(e));
        }
      }}
    />
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { appName, logo } = usePrefs();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("printninja-sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [reprintJob, setReprintJob] = useState<HistoryJob | null>(null);
  const [reprinting, setReprinting] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem("printninja-sidebar-collapsed", String(collapsed));
    } catch {}
  }, [collapsed]);

  const goto = useCallback(
    (key: string) => {
      const item = NAV_ITEMS.find((i) => i.shortcut === key);
      if (!item) return false;
      navigate(item.path);
      return true;
    },
    [navigate],
  );
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const openHelp = useCallback(() => setHelpOpen(true), []);
  useGlobalShortcuts({
    onPalette: openPalette,
    onHelp: openHelp,
    onGoto: goto,
  });

  // Printing is physical, so the palette asks before sending the last job again.
  const askReprintLast = async () => {
    try {
      const jobs = await agent("list_jobs");
      const last = [...jobs].sort((a, b) => b.id - a.id)[0];
      if (!last) {
        toast.info(t("shell.reprint_none"));
        return;
      }
      setReprintJob(last);
    } catch {
      toast.error(t("shell.reprint_failed"));
    }
  };

  const confirmReprint = async () => {
    if (!reprintJob) return;
    setReprinting(true);
    try {
      await agent("reprint_job", { id: reprintJob.id });
      toast.success(t("shell.reprint_done", { id: reprintJob.id }));
      setReprintJob(null);
    } catch {
      toast.error(t("shell.reprint_failed"));
    } finally {
      setReprinting(false);
    }
  };

  // The Designer's desktop workspace fills the viewport and scrolls inside its own
  // panes, so the page itself must not scroll there. (Below `lg` it scrolls as usual.)
  const fillsViewport =
    location.pathname === "/" || location.pathname.startsWith("/template/");

  const modKey =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform)
      ? "⌘"
      : "Ctrl";

  return (
    <div
      data-testid="shell-app"
      className="flex h-screen flex-col overflow-hidden bg-background"
    >
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        {t("shell.skip_to_content")}
      </a>

      {/* Top bar: same on every screen size */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-card px-3 pt-[env(safe-area-inset-top)] md:px-4">
        <Link
          to="/"
          className="flex items-center gap-2 rounded-md"
          aria-label={appName}
        >
          <AppLogo src={logo} />
          <span className="truncate text-base font-semibold tracking-tight">
            {appName}
          </span>
        </Link>
        <button
          type="button"
          onClick={openPalette}
          className="ml-2 hidden h-8 w-full max-w-sm items-center gap-2 rounded-md border border-input bg-card px-2.5 text-sm text-muted-foreground hover:bg-accent md:flex"
        >
          <Search className="h-4 w-4" aria-hidden="true" />
          <span className="flex-1 text-left">{t("shell.search")}</span>
          <kbd className="rounded border bg-muted px-1.5 font-mono text-xs">
            {modKey}+K
          </kbd>
        </button>
        <div className="ml-auto flex items-center gap-2">
          <div className="hidden sm:block">
            <ShareIndicator />
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={openPalette}
            aria-label={t("shell.search")}
          >
            <Search className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={openHelp}
            aria-label={t("shell.help")}
            title={t("shell.help")}
          >
            <CircleHelp className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <OfflineBanner />
      <AdoptionDialog />

      <div className="flex min-h-0 flex-1">
        {/* Sidebar: grouped by job */}
        <aside
          className={cn(
            "hidden shrink-0 flex-col border-r bg-card transition-[width] duration-150 md:flex",
            collapsed ? "w-14" : "w-56",
          )}
        >
          <nav
            aria-label={t("shell.primary_nav")}
            className="flex-1 space-y-4 overflow-y-auto p-2"
          >
            {NAV_GROUPS.map((group) => (
              <div key={group.id} className="space-y-0.5">
                {!collapsed ? (
                  <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                    {t(group.labelKey)}
                  </p>
                ) : (
                  <div className="mx-2 border-t first:hidden" />
                )}
                {group.items.map((item) => {
                  const active = isActivePath(location.pathname, item.path);
                  const label = t(item.labelKey);
                  return (
                    <Link
                      key={item.path}
                      to={item.path}
                      aria-current={active ? "page" : undefined}
                      aria-label={collapsed ? label : undefined}
                      title={collapsed ? label : undefined}
                      className={cn(
                        "flex h-control items-center gap-3 rounded-md px-2.5 text-sm transition-colors",
                        collapsed && "justify-center px-0",
                        active
                          ? "bg-accent font-medium text-accent-foreground"
                          : "text-foreground/80 hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <item.icon
                        className="h-4 w-4 shrink-0"
                        aria-hidden="true"
                      />
                      {!collapsed && label}
                    </Link>
                  );
                })}
              </div>
            ))}
          </nav>
          <div className="border-t p-2">
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "w-full",
                collapsed ? "justify-center px-0" : "justify-start gap-2",
              )}
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? t("shell.expand") : t("shell.collapse")}
              title={collapsed ? t("shell.expand") : t("shell.collapse")}
            >
              <ChevronRight
                className={cn(
                  "h-4 w-4 transition-transform",
                  !collapsed && "rotate-180",
                )}
                aria-hidden="true"
              />
              {!collapsed && (
                <span className="text-muted-foreground">
                  {t("shell.collapse")}
                </span>
              )}
            </Button>
          </div>
        </aside>

        <main
          id="main"
          tabIndex={-1}
          className={cn(
            "min-w-0 flex-1 overflow-y-auto focus:outline-none",
            fillsViewport && "lg:overflow-hidden",
          )}
        >
          <div
            className={cn(
              "mx-auto w-full max-w-[1600px] space-y-4 px-4 py-4 md:px-6 md:py-5",
              fillsViewport && "lg:flex lg:h-full lg:flex-col",
            )}
          >
            {children}
          </div>
        </main>
      </div>

      {/* Bottom bar on phones: same groups and labels as the sidebar */}
      <nav
        aria-label={t("shell.mobile_nav")}
        className="shrink-0 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <ul className="flex items-stretch">
          {NAV_ITEMS.map((item) => {
            const active = isActivePath(location.pathname, item.path);
            return (
              <li key={item.path} className="min-w-0 flex-1">
                <Link
                  to={item.path}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-14 flex-col items-center justify-center gap-1 px-0.5 text-xs transition-colors",
                    active
                      ? "font-semibold text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <item.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                  <span className="max-w-full truncate leading-none">
                    {t(item.labelKey)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onNavigate={(p) => navigate(p)}
        onReprintLast={askReprintLast}
      />
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <ConfirmDialog
        open={reprintJob != null}
        onOpenChange={(o) => {
          if (!o) setReprintJob(null);
        }}
        title={t("shell.reprint_title", { id: reprintJob?.id })}
        description={t("shell.reprint_body")}
        confirmLabel={t("shell.reprint_confirm")}
        busy={reprinting}
        onConfirm={confirmReprint}
      />
    </div>
  );
}
