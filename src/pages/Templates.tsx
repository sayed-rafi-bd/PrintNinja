import { useEffect, useMemo, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  Bookmark,
  BookmarkCheck,
  CloudDownload,
  CloudUpload,
  Eye,
  MoreHorizontal,
  Pencil,
  Printer,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/PageHeader";
import type { TemplateRow } from "@/lib/agent/types";
import { StatusBadge } from "@/components/StatusBadge";
import { agent } from "@/lib/agent/commands";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  ConflictDialog,
  type ConflictedRow,
} from "@/components/ConflictDialog";
import { DataTable } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { GetFromServerDialog } from "@/components/GetFromServerDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { usePrintStore } from "@/lib/store/printStore";
import { DEFAULT_MOCK_DATA } from "@/lib/templates/defaultTemplate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import * as share from "@/lib/share/client";
import { PHONE_QUERY, useMediaQuery } from "@/lib/hooks/useMediaQuery";
import { downloadToLocal } from "@/lib/share/sync";
import {
  deleteTemplateEverywhere,
  saveRowToServer,
  takeServerCopy,
} from "@/lib/share/save";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type ServerSummary = share.CommunitySummary;

export function TemplatesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState("mine");
  const [configured, setConfigured] = useState(true);
  const [removeTarget, setRemoveTarget] = useState<TemplateRow | null>(null);
  const [refreshTarget, setRefreshTarget] = useState<TemplateRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TemplateRow | null>(null);
  const [getOpen, setGetOpen] = useState(false);
  const [previewTpl, setPreviewTpl] = useState<ServerSummary | null>(null);
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [community, setCommunity] = useState<ServerSummary[]>([]);
  const [communityLoading, setCommunityLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("updated");
  // Debounced for the community query: every keystroke used to fire
  // fetchCommunityTemplates. The input stays live; the network waits.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(id);
  }, [search]);
  const [mine, setMine] = useState<TemplateRow[]>([]);
  const [saved, setSaved] = useState<TemplateRow[]>([]);
  // Controlled sorting for the phone-only sort dropdowns below: desktop
  // keeps header-button sorting on the same state.
  const [mineSorting, setMineSorting] = useState<SortingState>([]);
  const [savedSorting, setSavedSorting] = useState<SortingState>([]);
  const [mineSortKey, setMineSortKey] = useState("");
  const [savedSortKey, setSavedSortKey] = useState("");
  const isPhone = useMediaQuery(PHONE_QUERY);
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);
  /** Saved copies the server no longer has. The local copy still prints. */
  const [gone, setGone] = useState<Set<number>>(new Set());
  /** Rows the server refused with 409. The dialog resolves them. */
  const [conflicts, setConflicts] = useState<ConflictedRow[]>([]);
  const [conflictOpen, setConflictOpen] = useState(false);
  // Position in the conflict queue: resolving one advances to the next
  // instead of dropping the rest (the old code only ever showed [0]).
  const [conflictIdx, setConflictIdx] = useState(0);

  const advanceConflict = () => {
    if (conflictIdx + 1 < conflicts.length) {
      setConflictIdx(conflictIdx + 1);
    } else {
      setConflictOpen(false);
      setConflictIdx(0);
    }
    void loadMine();
  };

  const loadMine = useCallback(async () => {
    try {
      const list = await agent("list_templates", {});
      setMine(list.filter((t) => t.origin === "own"));
      setSaved(list.filter((t) => t.origin === "saved"));
    } catch {
      setMine([]);
      setSaved([]);
    }
    try {
      const rows = await agent("cache_list_conflicted", {});
      setConflicts(Array.isArray(rows) ? rows : []);
    } catch {
      setConflicts([]);
    }
  }, []);

  const loadCommunity = useCallback(async () => {
    const url = await share.getServiceUrl();
    setConfigured(!!url);
    if (!url) {
      setCommunity([]);
      setOffline(false);
      return;
    }
    setCommunityLoading(true);
    setOffline(false);
    try {
      setCommunity(
        await share.fetchCommunityTemplates({
          q: debouncedSearch,
          sort: sort as "updated" | "used" | "name",
        }),
      );
    } catch {
      setOffline(true);
      setCommunity([]);
    } finally {
      setCommunityLoading(false);
    }
  }, [debouncedSearch, sort]);

  useEffect(() => {
    loadMine();
  }, [loadMine]);

  // A completed pull lands rows after mount; reload the lists so the new
  // content shows with no manual Refresh (F3/F4).
  useEffect(() => {
    const onPulled = () => void loadMine();
    window.addEventListener("sync:pulled", onPulled);
    return () => window.removeEventListener("sync:pulled", onPulled);
  }, [loadMine]);

  useEffect(() => {
    if (activeTab === "community") loadCommunity();
  }, [activeTab, loadCommunity]);

  // A saved copy whose template is no longer on the server is withdrawn by its
  // author. Nothing is written locally: the copy stays, and still prints.
  // Withdrawal checks run bounded-parallel (5 at a time): the old serial
  // loop made a large Saved tab take one round trip per row.
  useEffect(() => {
    if (activeTab !== "saved" || saved.length === 0) return;
    let cancelled = false;
    (async () => {
      const missing = new Set<number>();
      const queue = saved.filter((tpl) => tpl.remote_id);
      const lane = async () => {
        while (!cancelled) {
          const tpl = queue.shift();
          if (!tpl?.remote_id) return;
          try {
            await share.fetchRemoteTemplate(tpl.remote_id);
          } catch (e) {
            // Only a template the server says is gone counts. An
            // unreachable server or an ended session says nothing about
            // the template itself.
            if (e instanceof share.RemoteTemplateNotFoundError)
              missing.add(tpl.id);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(5, queue.length) }, () => lane()),
      );
      if (!cancelled) {
        // Only re-render when the answer changed; the table is expensive to rebuild.
        setGone((prev) =>
          prev.size === missing.size && [...missing].every((id) => prev.has(id))
            ? prev
            : missing,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab, saved]);

  const handleSaveToServer = async (tpl: TemplateRow) => {
    if (syncing != null) return;
    setSyncing(tpl.id);
    try {
      await saveRowToServer(tpl);
      toast.success(t("templates.toast_saved_server", { name: tpl.name }));
      await loadMine();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(null);
    }
  };

  const handleDelete = async (tpl: TemplateRow) => {
    if (syncing != null) return;
    setSyncing(tpl.id);
    try {
      // Server first, then the cache: offline the button that opens this
      // dialog is disabled, so there is no queue to drain later.
      await deleteTemplateEverywhere(tpl);
      toast.success(
        t("templates.toast_deleted_everywhere", { name: tpl.name }),
      );
      await loadMine();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(null);
    }
  };

  const handleRefresh = async (tpl: TemplateRow) => {
    if (syncing != null) return;
    setSyncing(tpl.id);
    try {
      const result = await takeServerCopy(tpl);
      toast.success(t("templates.toast_refreshed", { name: result.name }));
      await loadMine();
    } catch (e) {
      // The local copy is untouched when the fetch fails, so it still prints.
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(null);
    }
  };

  const handleSave = async (serverTpl: ServerSummary) => {
    if (saving.has(serverTpl.id)) return;
    const url = await share.getServiceUrl();
    if (!url) {
      toast.error(t("templates.toast_share_unconfigured"));
      return;
    }
    const token = await share.getSessionToken();
    if (!token) {
      toast.error(t("templates.toast_signin_required"));
      return;
    }

    // Optimistic: show filled star immediately
    setSaving((s) => new Set(s).add(serverTpl.id));
    try {
      // 1. Record the save on the server (idempotent), 2. put a local copy on
      // this PC with its CSS and README, marked read-only.
      await share.saveRemoteTemplate(serverTpl.id);
      const result = await downloadToLocal(
        serverTpl.id,
        "saved",
        serverTpl.owner_handle,
      );
      if (!result.created) {
        toast.success(t("templates.toast_already_saved"));
        return;
      }
      toast.success(t("templates.toast_saved_local", { name: serverTpl.name }));
      await loadMine();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e), {
        description: t("templates.toast_tap_retry"),
        action: {
          label: t("templates.toast_retry"),
          onClick: () => handleSave(serverTpl),
        },
      });
    } finally {
      setSaving((s) => {
        const n = new Set(s);
        n.delete(serverTpl.id);
        return n;
      });
    }
  };

  const handleUnsave = async (localTpl: TemplateRow) => {
    if (!localTpl.remote_id) return;
    try {
      await share.unsaveRemoteTemplate(localTpl.remote_id);
    } catch (e) {
      // Saving is a network operation: without the server round-trip the
      // copy stays, and the next pull (which still lists it as saved)
      // would bring it right back.
      toast.error(e instanceof Error ? e.message : String(e));
      return;
    }
    // The server confirmed the unsave, so the local copy is forgotten
    // outright — no tombstone, nothing for the engine to push.
    try {
      await agent("cache_forget_template", {
        server_id: localTpl.server_id ?? localTpl.remote_id,
      });
      toast.success(t("templates.toast_removed_saved"));
      await loadMine();
    } catch (e) {
      toast.error(String(e));
    }
  };

  // Opens the Print page with this template selected.
  const handleUse = async (tpl: TemplateRow, isSavedCopy: boolean) => {
    // For saved copies, queue a use count locally; the sync engine sends
    // it later (section 6.6). Never blocks navigation, silent if offline.
    if (isSavedCopy && tpl.remote_id) {
      try {
        await agent("cache_queue_use", { server_id: tpl.remote_id, delta: 1 });
      } catch {}
    }
    usePrintStore.getState().setTemplateId(String(tpl.id));
    navigate("/print");
  };

  const openPreview = async (tpl: ServerSummary) => {
    setPreviewTpl(tpl);
    setPreviewHtml("");
    setPreviewError("");
    try {
      const detail = await share.fetchRemoteTemplate(tpl.id);
      const { renderTemplate } = await import("@/lib/render/renderTemplate");
      const { compileTemplateCss } = await import(
        "@/lib/templates/compileTemplateCss"
      );
      const { css: compiled } = await compileTemplateCss(detail.body ?? "");
      setPreviewHtml(
        renderTemplate(
          detail.body ?? "",
          detail.css ?? "",
          DEFAULT_MOCK_DATA as any,
          compiled,
        ),
      );
    } catch (e) {
      setPreviewError(`Could not load the preview: ${e}`);
    }
  };

  const isSaved = (serverId: string) =>
    saved.some((t) => t.remote_id === serverId);

  // Shared by the table cells and the phone cards below.
  // Every local row carries a server id (minted at creation), so "on the
  // server" means the server has actually seen it: the row records the
  // revision it was last synced at.
  const mineStatus = (tpl: TemplateRow) => {
    if (tpl.base_revision == null)
      return (
        <StatusBadge
          status="draft"
          label={t("templates.status_not_on_server")}
        />
      );
    if (!tpl.published_at)
      return (
        <StatusBadge status="draft" label={t("templates.status_private")} />
      );
    return share.hasUnpublishedChanges(tpl) ? (
      <StatusBadge status="draft" label={t("templates.status_changes")} />
    ) : (
      <StatusBadge status="published" />
    );
  };
  const savedStatus = (tpl: TemplateRow) =>
    tpl.withdrawn || gone.has(tpl.id) ? (
      <StatusBadge status="withdrawn" label={t("templates.status_withdrawn")} />
    ) : (
      <StatusBadge status="saved" />
    );

  // ⋯ menu for phone cards: the same actions and handlers as the table row.
  // The wrapper stops the tap from also activating the card.
  const cardMenu = (name: string, items: ReactNode) => (
    <div
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className="shrink-0"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("common.actions_for", { name })}
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">{items}</DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  // Phone cards: name + summary, status badge and page
  // size, kebab menu for actions. Tapping a Mine card opens the Designer
  // via the DataTable's onRowActivate.
  const mineCard = (tpl: TemplateRow) => (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{tpl.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {tpl.summary || t("templates.no_summary")}
          </p>
        </div>
        {cardMenu(
          tpl.name,
          <>
            <DropdownMenuItem
              disabled={syncing != null}
              onSelect={() => handleSaveToServer(tpl)}
            >
              <CloudUpload className="h-4 w-4" aria-hidden="true" />
              {t("templates.action_save_server", { name: tpl.name })}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={syncing != null}
              onSelect={() => setRefreshTarget(tpl)}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              {t("templates.action_refresh_server", { name: tpl.name })}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => navigate(`/template/${tpl.id}`)}>
              <Pencil className="h-4 w-4" aria-hidden="true" />
              {t("common.edit")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => handleUse(tpl, false)}>
              <Printer className="h-4 w-4" aria-hidden="true" />
              {t("templates.action_print")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={syncing != null}
              onSelect={() => setDeleteTarget(tpl)}
              className="text-danger focus:text-danger"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              {t("templates.action_delete_everywhere", { name: tpl.name })}
            </DropdownMenuItem>
          </>,
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {mineStatus(tpl)}
        <span className="text-xs text-muted-foreground">
          {t("templates.page_size", { w: tpl.page_w_mm, h: tpl.page_h_mm })}
        </span>
      </div>
    </div>
  );
  const savedCard = (tpl: TemplateRow) => (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{tpl.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {tpl.summary || t("templates.no_summary")}
          </p>
        </div>
        {cardMenu(
          tpl.name,
          <>
            <DropdownMenuItem
              disabled={syncing != null}
              onSelect={() => setRefreshTarget(tpl)}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              {t("templates.action_refresh_server", { name: tpl.name })}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => handleUse(tpl, true)}>
              <Printer className="h-4 w-4" aria-hidden="true" />
              {t("templates.action_print")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setRemoveTarget(tpl)}
              className="text-danger focus:text-danger"
            >
              {t("templates.action_remove")}
            </DropdownMenuItem>
          </>,
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {savedStatus(tpl)}
        <span className="text-xs text-muted-foreground">
          {t("templates.saved_from", {
            owner: tpl.origin_owner ?? t("templates.unknown_owner"),
          })}
        </span>
      </div>
    </div>
  );

  // Phone-only sort dropdown: cards have no headers to sort by. Desktop
  // keeps header-button sorting on the same state.
  const sortSelect = (
    id: string,
    sortKey: string,
    onSortKey: (key: string) => void,
    withUpdated: boolean,
  ) => (
    <div className="mb-2 flex items-center justify-end gap-2">
      <Label htmlFor={id}>{t("templates.sort_label")}</Label>
      <Select value={sortKey} onValueChange={onSortKey}>
        <SelectTrigger
          id={id}
          aria-label={t("templates.sort_aria")}
          className="w-[170px]"
        >
          <SelectValue placeholder={t("templates.sort_placeholder")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="name">{t("templates.sort_name")}</SelectItem>
          {withUpdated && (
            <SelectItem value="updated">
              {t("templates.sort_updated")}
            </SelectItem>
          )}
        </SelectContent>
      </Select>
    </div>
  );
  const applySortKey = (
    key: string,
    setKey: (k: string) => void,
    setSorting: (s: SortingState) => void,
  ) => {
    setKey(key);
    if (key === "name") setSorting([{ id: "name", desc: false }]);
    else if (key === "updated") setSorting([{ id: "updated", desc: true }]);
    else setSorting([]);
  };

  const mineColumns = useMemo<ColumnDef<TemplateRow>[]>(
    () => [
      {
        id: "name",
        header: t("templates.col_template"),
        accessorFn: (r) => r.name.toLowerCase(),
        enableSorting: true,
        cell: (c) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{c.row.original.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {c.row.original.summary || t("templates.no_summary")}
            </p>
          </div>
        ),
      },
      {
        id: "status",
        header: t("common.status"),
        cell: (c) => mineStatus(c.row.original),
      },
      {
        id: "size",
        header: t("templates.col_size"),
        meta: { className: "hidden md:table-cell" },
        cell: (c) =>
          `${c.row.original.page_w_mm} × ${c.row.original.page_h_mm} mm`,
      },
      {
        id: "updated",
        header: t("common.updated"),
        accessorFn: (r) => r.updated_at,
        enableSorting: true,
        meta: { className: "hidden md:table-cell" },
        cell: (c) => c.row.original.updated_at.slice(0, 10),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{t("common.actions")}</span>,
        meta: { className: "text-right" },
        cell: (c) => {
          const tpl = c.row.original;
          return (
            <div
              className="flex justify-end gap-2"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("templates.action_save_server", {
                  name: tpl.name,
                })}
                title={t("templates.action_save_server_title", {
                  name: tpl.name,
                })}
                disabled={syncing != null}
                onClick={() => handleSaveToServer(tpl)}
              >
                <CloudUpload className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("templates.action_refresh_server", {
                  name: tpl.name,
                })}
                title={t("templates.action_refresh_server_title", {
                  name: tpl.name,
                })}
                disabled={syncing != null}
                onClick={() => setRefreshTarget(tpl)}
              >
                <RefreshCw
                  className={cn(
                    "h-4 w-4",
                    syncing === tpl.id && "motion-safe:animate-spin",
                  )}
                  aria-hidden="true"
                />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("templates.action_delete_everywhere", {
                  name: tpl.name,
                })}
                title={t("templates.action_delete_title", { name: tpl.name })}
                disabled={syncing != null}
                onClick={() => setDeleteTarget(tpl)}
                className="text-danger hover:text-danger"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => navigate(`/template/${tpl.id}`)}
              >
                <Pencil className="h-4 w-4" aria-hidden="true" />
                {t("common.edit")}
              </Button>
              <Button size="sm" onClick={() => handleUse(tpl, false)}>
                <Printer className="h-4 w-4" aria-hidden="true" />
                {t("templates.action_print")}
              </Button>
            </div>
          );
        },
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
    ],
    [syncing],
  );

  const savedColumns = useMemo<ColumnDef<TemplateRow>[]>(
    () => [
      {
        id: "name",
        header: t("templates.col_template"),
        accessorFn: (r) => r.name.toLowerCase(),
        enableSorting: true,
        cell: (c) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{c.row.original.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {c.row.original.summary || t("templates.no_summary")}
            </p>
          </div>
        ),
      },
      {
        id: "from",
        header: t("templates.saved_from_header"),
        meta: { className: "hidden md:table-cell" },
        cell: (c) =>
          c.row.original.origin_owner ?? t("templates.unknown_owner"),
      },
      {
        id: "status",
        header: t("common.status"),
        cell: (c) => savedStatus(c.row.original),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{t("common.actions")}</span>,
        meta: { className: "text-right" },
        cell: (c) => {
          const tpl = c.row.original;
          return (
            <div
              className="flex justify-end gap-2"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("templates.action_refresh_server", {
                  name: tpl.name,
                })}
                title={t("templates.action_refresh_server_title", {
                  name: tpl.name,
                })}
                disabled={syncing != null}
                onClick={() => setRefreshTarget(tpl)}
              >
                <RefreshCw
                  className={cn(
                    "h-4 w-4",
                    syncing === tpl.id && "motion-safe:animate-spin",
                  )}
                  aria-hidden="true"
                />
              </Button>
              <Button size="sm" onClick={() => handleUse(tpl, true)}>
                <Printer className="h-4 w-4" aria-hidden="true" />
                {t("templates.action_print")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setRemoveTarget(tpl)}
              >
                {t("templates.action_remove")}
              </Button>
            </div>
          );
        },
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
    ],
    [syncing, gone],
  );

  return (
    <div className="space-y-4">
      <PageHeader title={t("nav.templates")} description={t("pages.templates")}>
        <Button variant="outline" onClick={() => setGetOpen(true)}>
          <CloudDownload className="h-4 w-4" aria-hidden="true" />
          {t("templates.get_from_server")}
        </Button>
      </PageHeader>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="mine">
            {t("templates.tab_mine")} ({mine.length})
          </TabsTrigger>
          <TabsTrigger value="saved">
            {t("templates.tab_saved")} ({saved.length})
          </TabsTrigger>
          <TabsTrigger value="community">
            {t("templates.tab_community")}
          </TabsTrigger>
        </TabsList>

        {/* Mine */}
        <TabsContent value="mine" className="mt-4">
          {isPhone &&
            sortSelect(
              "mine-sort",
              mineSortKey,
              (k) => applySortKey(k, setMineSortKey, setMineSorting),
              true,
            )}
          {conflicts.length > 0 && (
            <div
              data-testid="conflict-banner"
              className="mb-4 flex items-center justify-between gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
            >
              <span>
                {conflicts.length === 1
                  ? t("templates.conflict_single", { name: conflicts[0].name })
                  : t("templates.conflict_many", { count: conflicts.length })}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setConflictIdx(0);
                  setConflictOpen(true);
                }}
              >
                {t("templates.conflict_review")}
              </Button>
            </div>
          )}
          <DataTable
            caption="My templates"
            columns={mineColumns}
            data={mine}
            getRowId={(r) => String(r.id)}
            onRowActivate={(r) => navigate(`/template/${r.id}`)}
            sorting={mineSorting}
            onSortingChange={setMineSorting}
            renderCard={mineCard}
            empty={{
              title: t("templates.empty_mine_title"),
              description: t("templates.empty_mine_desc"),
              action: {
                label: t("templates.empty_mine_action"),
                onClick: () => navigate("/"),
              },
            }}
          />
        </TabsContent>

        {/* Saved */}
        <TabsContent value="saved" className="mt-4">
          {isPhone &&
            sortSelect(
              "saved-sort",
              savedSortKey,
              (k) => applySortKey(k, setSavedSortKey, setSavedSorting),
              false,
            )}
          <DataTable
            caption="Saved templates"
            columns={savedColumns}
            data={saved}
            getRowId={(r) => String(r.id)}
            sorting={savedSorting}
            onSortingChange={setSavedSorting}
            renderCard={savedCard}
            empty={{
              title: t("templates.empty_saved_title"),
              description: t("templates.empty_saved_desc"),
              action: {
                label: t("templates.empty_saved_action"),
                onClick: () => setActiveTab("community"),
              },
            }}
          />
        </TabsContent>

        {/* Community gallery: previews matter here, so cards stay */}
        <TabsContent value="community" className="mt-4 space-y-4">
          <div className="flex flex-col gap-2 md:flex-row">
            <Input
              aria-label={t("templates.search_label")}
              placeholder={t("templates.search_placeholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1"
            />
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger
                aria-label={t("templates.sort_aria")}
                className="w-full md:w-[170px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="updated">
                  {t("templates.sort_updated")}
                </SelectItem>
                <SelectItem value="used">{t("templates.sort_used")}</SelectItem>
                <SelectItem value="name">
                  {t("templates.sort_alpha")}
                </SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={loadCommunity}>
              {t("templates.refresh")}
            </Button>
          </div>

          {!configured ? (
            <Card>
              <EmptyState
                title={t("templates.no_share_title")}
                description={t("templates.no_share_hint")}
                action={{
                  label: t("templates.no_share_action"),
                  onClick: () => navigate("/settings"),
                }}
              />
            </Card>
          ) : offline ? (
            <Card>
              <EmptyState
                title={t("templates.offline_title")}
                description={t("templates.offline_hint")}
                action={{
                  label: t("templates.offline_retry"),
                  onClick: loadCommunity,
                }}
              />
            </Card>
          ) : communityLoading ? (
            <p className="text-sm text-muted-foreground" role="status">
              {t("templates.loading")}
            </p>
          ) : community.length === 0 ? (
            <Card>
              <EmptyState
                title={t("templates.empty_community_title")}
                description={t("templates.empty_community_hint")}
              />
            </Card>
          ) : (
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {community.map((tpl) => {
                const savedState = isSaved(tpl.id);
                const savingState = saving.has(tpl.id);
                const own = mine.some(
                  (m) => m.remote_id === tpl.id || m.server_id === tpl.id,
                );
                return (
                  <li key={tpl.id}>
                    <Card className="h-full">
                      <CardContent className="space-y-2 p-4">
                        <div className="flex items-start justify-between gap-2">
                          <h2 className="truncate font-medium">{tpl.name}</h2>
                          {own ? (
                            <StatusBadge
                              status="published"
                              label={t("templates.server_mine")}
                            />
                          ) : (
                            <Badge variant="outline">
                              {t("templates.badge_community")}
                            </Badge>
                          )}
                        </div>
                        <p className="line-clamp-2 text-xs text-muted-foreground">
                          {tpl.summary || t("templates.no_summary")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t("templates.meta_line", {
                            owner: tpl.owner_handle,
                            uses: tpl.use_count,
                            w: tpl.page_w_mm,
                            h: tpl.page_h_mm,
                          })}
                        </p>
                        <div className="flex gap-2 pt-2">
                          {!own && (
                            <Button
                              size="sm"
                              variant={savedState ? "secondary" : "default"}
                              aria-pressed={savedState}
                              disabled={savedState || savingState}
                              onClick={() => handleSave(tpl)}
                            >
                              {savedState ? (
                                <BookmarkCheck
                                  className="h-4 w-4"
                                  aria-hidden="true"
                                />
                              ) : (
                                <Bookmark
                                  className="h-4 w-4"
                                  aria-hidden="true"
                                />
                              )}
                              {savingState
                                ? t("templates.saving")
                                : savedState
                                  ? t("templates.saved_label")
                                  : t("templates.save_action")}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openPreview(tpl)}
                          >
                            <Eye className="h-4 w-4" aria-hidden="true" />
                            {t("templates.preview_action")}
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        title={
          deleteTarget
            ? t("templates.delete_title", { name: deleteTarget.name })
            : ""
        }
        description={t("templates.delete_body")}
        confirmLabel={t("templates.delete_confirm")}
        destructive
        onConfirm={async () => {
          if (deleteTarget) await handleDelete(deleteTarget);
          setDeleteTarget(null);
        }}
      />

      <ConfirmDialog
        open={refreshTarget != null}
        onOpenChange={(o) => {
          if (!o) setRefreshTarget(null);
        }}
        title={
          refreshTarget
            ? t("templates.refresh_title", { name: refreshTarget.name })
            : ""
        }
        description={t("templates.refresh_body")}
        confirmLabel={t("templates.refresh_confirm")}
        onConfirm={async () => {
          if (refreshTarget) await handleRefresh(refreshTarget);
          setRefreshTarget(null);
        }}
      />

      <GetFromServerDialog
        open={getOpen}
        onOpenChange={setGetOpen}
        onDownloaded={() => {
          void loadMine();
          setActiveTab("mine");
        }}
      />

      <ConflictDialog
        conflict={conflictOpen ? (conflicts[conflictIdx] ?? null) : null}
        position={{ index: conflictIdx, total: conflicts.length }}
        onOpenChange={setConflictOpen}
        onResolved={advanceConflict}
      />

      <ConfirmDialog
        open={removeTarget != null}
        onOpenChange={(o) => {
          if (!o) setRemoveTarget(null);
        }}
        title={
          removeTarget
            ? t("templates.remove_title", { name: removeTarget.name })
            : ""
        }
        description={t("templates.remove_body")}
        confirmLabel={t("templates.remove_confirm")}
        destructive
        onConfirm={async () => {
          if (removeTarget) await handleUnsave(removeTarget);
          setRemoveTarget(null);
        }}
      />

      <Dialog
        open={previewTpl != null}
        onOpenChange={(o) => {
          if (!o) setPreviewTpl(null);
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{previewTpl?.name}</DialogTitle>
            <DialogDescription>
              {previewTpl
                ? t("templates.preview_subtitle", {
                    w: previewTpl.page_w_mm,
                    h: previewTpl.page_h_mm,
                  })
                : ""}
            </DialogDescription>
          </DialogHeader>
          {previewError ? (
            <p
              role="alert"
              className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
            >
              {previewError}
            </p>
          ) : previewHtml ? (
            <div
              className="max-h-[60vh] overflow-auto rounded-md border bg-muted p-4"
              tabIndex={0}
              role="region"
              aria-label={t("templates.preview_region")}
            >
              <div
                className="mx-auto bg-white shadow-md"
                style={{
                  width: (previewTpl?.page_w_mm ?? 80) * 3.7795,
                  maxWidth: "100%",
                }}
              >
                <iframe
                  srcDoc={previewHtml}
                  sandbox=""
                  className="w-full border-0"
                  style={{ height: (previewTpl?.page_h_mm ?? 200) * 3.7795 }}
                  title={t("templates.preview_region")}
                />
              </div>
            </div>
          ) : (
            <p
              className="py-8 text-center text-sm text-muted-foreground"
              role="status"
            >
              {t("templates.preview_loading")}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewTpl(null)}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
