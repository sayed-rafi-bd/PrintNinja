import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ChevronRight, CircleHelp, MoreHorizontal, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AppLogo } from "@/components/AppLogo";
import { CommandPalette } from "@/components/CommandPalette";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import type { HistoryJob } from "@/lib/store/historyStore";
import {
  MOBILE_MORE_ITEMS,
  MOBILE_PRIMARY_ITEMS,
  NAV_GROUPS,
  NAV_ITEMS,
  isActivePath,
} from "@/lib/shell/nav";
import { useGlobalShortcuts } from "@/lib/shell/useGlobalShortcuts";
import { LANDSCAPE_QUERY, useMediaQuery } from "@/lib/hooks/useMediaQuery";
import { useShareStatus } from "@/lib/shell/useShareStatus";
import { cacheNow, useSyncStatus } from "@/lib/sync/useSyncStatus";
import { usePrefs } from "@/lib/prefs/PrefsProvider";
import { agent } from "@/lib/agent/commands";
import { cn } from "@/lib/utils";

function ShareIndicator() {
  const { t } = useTranslation();
  const status = useShareStatus();
  const sync = useSyncStatus();
  const [busy, setBusy] = useState(false);
  if (status.state === "unconfigured") return null;
  if (status.state === "offline") {
    return (
      <Link to="/settings" title={t("shell.share_offline")}>
        <StatusBadge
          status="offline"
          label={t("shell.share_offline")}
          compact
        />
      </Link>
    );
  }
  if (status.state !== "online") {
    return (
      <Link
        to="/settings"
        title={t("shell.share_signed_out")}
        className="flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
      >
        {/* Phone: an amber dot keeps the "not signed in" signal visible in the
            top bar; the word returns from sm up. */}
        <span
          className="h-2 w-2 shrink-0 rounded-full bg-warning sm:hidden"
          aria-hidden="true"
        />
        <span className="hidden sm:inline">{t("shell.share_signed_out")}</span>
        <span className="sr-only sm:hidden">{t("shell.share_signed_out")}</span>
      </Link>
    );
  }
  // Online: the connection badge always shows, and the cache gets its
  // own button. Clicking it refreshes the cache from the server (pull
  // only — saving is a manual action, so there is nothing to push).
  const syncing = busy || sync.state === "syncing";
  const detail = sync.lastError
    ? t("shell.sync_failed", { error: sync.lastError })
    : sync.drafts > 0
      ? t("shell.sync_drafts", { count: sync.drafts })
      : sync.lastPulledAt
        ? t("shell.sync_synced", { time: sync.lastPulledAt })
        : t("shell.share_online", { handle: status.handle });
  const syncBadge = syncing ? (
    <StatusBadge status="syncing" compact />
  ) : (
    <StatusBadge status="synced" compact />
  );
  const onCacheNow = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await cacheNow();
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex items-center gap-2">
      <span title={t("shell.share_online", { handle: status.handle })}>
        <StatusBadge
          status="online"
          label={status.handle || t("status.online")}
          compact
        />
      </span>
      <button
        type="button"
        data-testid="sync-chip"
        title={`${t("shell.sync_now")} — ${detail}`}
        aria-label={`${t("shell.sync_now")}: ${detail}`}
        onClick={() => void onCacheNow()}
        disabled={syncing}
        className="rounded-md hover:opacity-80 disabled:cursor-wait disabled:hover:opacity-100"
      >
        {syncBadge}
      </button>
    </span>
  );
}

/** Topbar badge while the local API server runs. LAN exposure stays a
 * red alert; loopback serving shows a green badge with the bind address.
 * Both link to Settings → API, where the server stops and LAN turns off. */
function ApiIndicator() {
  const { t } = useTranslation();
  const location = useLocation();
  const [status, setStatus] = useState<{
    running: boolean;
    address: string;
    port: number;
    lan_access: boolean;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const s = await agent("get_api_status", {});
        if (!cancelled) setStatus(s);
      } catch {
        if (!cancelled) setStatus(null);
      }
    };
    void check();
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", check);
    };
  }, [location.pathname]);
  if (!status?.running) return null;
  if (status.lan_access) {
    return (
      <Link
        to="/settings?section=api"
        title={`${t("shell.lan_on")} — ${t("shell.lan_on_detail")}`}
        aria-label={`${t("shell.lan_on")}: ${t("shell.lan_on_detail")}`}
        data-testid="lan-indicator"
      >
        <StatusBadge status="lan" label={t("shell.lan_on")} />
      </Link>
    );
  }
  const where = `${status.address}:${status.port}`;
  return (
    <Link
      to="/settings?section=api"
      title={`API server listening on ${where}`}
      aria-label={`API server listening on ${where}`}
      data-testid="api-indicator"
    >
      <StatusBadge status="api" />
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
  const [moreOpen, setMoreOpen] = useState(false);
  // Landscape phone (coarse pointer, short height): the desktop layout is
  // active by width, but there is no room for an open sidebar or the wide
  // search field — force the icon rail and the palette icon button instead.
  const shortLandscape = useMediaQuery(LANDSCAPE_QUERY);
  const rail = collapsed || shortLandscape;
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
      className="flex h-dvh-safe flex-col overflow-hidden bg-background"
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
          className="flex items-center gap-2 rounded-md [@media(pointer:coarse)]:py-2"
          aria-label={appName}
        >
          <AppLogo src={logo} />
          <span className="truncate text-base font-semibold tracking-tight">
            {appName}
          </span>
        </Link>
        {!shortLandscape && (
          <button
            type="button"
            onClick={openPalette}
            className="ml-2 hidden h-8 w-full max-w-sm items-center gap-2 rounded-md border border-input bg-card px-2.5 text-sm text-muted-foreground hover:bg-accent md:flex"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            <span className="flex-1 text-left">{t("shell.search")}</span>
            <kbd className="rounded border bg-muted px-1.5 font-mono text-xs [@media(pointer:coarse)]:hidden">
              {modKey}+K
            </kbd>
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <ApiIndicator />
          {/* Share/sync state stays visible on phones as a compact icon-only
              badge; the word returns from sm up (see StatusBadge compact). */}
          <ShareIndicator />
          <Button
            variant="ghost"
            size="icon"
            className={shortLandscape ? undefined : "md:hidden"}
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

      <div className="flex min-h-0 flex-1">
        {/* Sidebar: grouped by job. Landscape phones force the icon rail. */}
        <aside
          className={cn(
            "hidden shrink-0 flex-col border-r bg-card transition-[width] duration-150 md:flex",
            rail ? "w-14" : "w-56",
          )}
        >
          <nav
            aria-label={t("shell.primary_nav")}
            className="flex-1 space-y-4 overflow-y-auto p-2"
          >
            {NAV_GROUPS.map((group) => (
              <div key={group.id} className="space-y-0.5">
                {!rail ? (
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
                      aria-label={rail ? label : undefined}
                      title={rail ? label : undefined}
                      className={cn(
                        "flex h-control items-center gap-3 rounded-md px-2.5 text-sm transition-colors",
                        rail && "justify-center px-0",
                        active
                          ? "bg-accent font-medium text-accent-foreground"
                          : "text-foreground/80 hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <item.icon
                        className="h-4 w-4 shrink-0"
                        aria-hidden="true"
                      />
                      {!rail && label}
                    </Link>
                  );
                })}
              </div>
            ))}
          </nav>
          {/* No room to expand in a short landscape viewport. */}
          {!shortLandscape && (
            <div className="border-t p-2">
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "w-full",
                  rail ? "justify-center px-0" : "justify-start gap-2",
                )}
                onClick={() => setCollapsed((v) => !v)}
                aria-label={rail ? t("shell.expand") : t("shell.collapse")}
                title={rail ? t("shell.expand") : t("shell.collapse")}
              >
                <ChevronRight
                  className={cn(
                    "h-4 w-4 transition-transform",
                    !rail && "rotate-180",
                  )}
                  aria-hidden="true"
                />
                {!rail && (
                  <span className="text-muted-foreground">
                    {t("shell.collapse")}
                  </span>
                )}
              </Button>
            </div>
          )}
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

      {/* Bottom bar on phones: four primary pages plus More, so the bar is
          five evenly-sized tap targets instead of a squeezed icon row. */}
      <nav
        aria-label={t("shell.mobile_nav")}
        className="shrink-0 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <ul className="flex items-stretch">
          {MOBILE_PRIMARY_ITEMS.map((item) => {
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
          <li className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-expanded={moreOpen}
              className={cn(
                "flex min-h-14 w-full flex-col items-center justify-center gap-1 px-0.5 text-xs transition-colors",
                MOBILE_MORE_ITEMS.some((item) =>
                  isActivePath(location.pathname, item.path),
                )
                  ? "font-semibold text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <MoreHorizontal className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span className="max-w-full truncate leading-none">
                {t("nav.more")}
              </span>
            </button>
          </li>
        </ul>
      </nav>

      {/* The pages that do not fit the five-slot bar live here */}
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent
          side="bottom"
          className="flex w-full flex-col gap-0 p-0 pb-[env(safe-area-inset-bottom)] sm:max-w-sm"
        >
          <DialogHeader className="border-b p-5 pr-12">
            <DialogTitle>{t("nav.more_title")}</DialogTitle>
            <DialogDescription>{t("shell.more_description")}</DialogDescription>
          </DialogHeader>
          <ul className="flex-1 overflow-y-auto p-2">
            {MOBILE_MORE_ITEMS.map((item) => (
              <li key={item.path}>
                <Link
                  to={item.path}
                  onClick={() => setMoreOpen(false)}
                  aria-current={
                    isActivePath(location.pathname, item.path)
                      ? "page"
                      : undefined
                  }
                  className={cn(
                    "flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                    isActivePath(location.pathname, item.path)
                      ? "bg-accent font-semibold text-accent-foreground"
                      : "text-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {t(item.labelKey)}
                </Link>
              </li>
            ))}
          </ul>
        </SheetContent>
      </Sheet>

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
