import { useEffect, useMemo, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Bookmark,
  BookmarkCheck,
  CloudDownload,
  CloudUpload,
  Eye,
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
import { downloadToLocal } from "@/lib/share/sync";
import {
  deleteTemplateEverywhere,
  saveRowToServer,
  takeServerCopy,
} from "@/lib/share/save";
import { cn } from "@/lib/utils";

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
      toast.success(`Saved “${tpl.name}” to the server`);
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
      toast.success(`Deleted “${tpl.name}” everywhere`);
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
      toast.success(`Refreshed “${result.name}” from the server`);
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
      toast.error("Share service not configured");
      return;
    }
    const token = await share.getSessionToken();
    if (!token) {
      toast.error("Sign in to save templates");
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
        toast.success("Already saved");
        return;
      }
      toast.success(`Saved "${serverTpl.name}"`);
      await loadMine();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e), {
        description: "Tap to retry",
        action: { label: "Retry", onClick: () => handleSave(serverTpl) },
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
      toast.success("Removed from Saved");
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

  const mineColumns = useMemo<ColumnDef<TemplateRow>[]>(
    () => [
      {
        id: "name",
        header: "Template",
        accessorFn: (r) => r.name.toLowerCase(),
        enableSorting: true,
        cell: (c) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{c.row.original.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {c.row.original.summary || "No summary"}
            </p>
          </div>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: (c) => {
          const tpl = c.row.original;
          // Every local row carries a server id (minted at creation), so
          // "on the server" means the server has actually seen it: the
          // row records the revision it was last synced at.
          if (tpl.base_revision == null)
            return <StatusBadge status="draft" label="Not on the server" />;
          if (!tpl.published_at)
            return <StatusBadge status="draft" label="Private" />;
          return share.hasUnpublishedChanges(tpl) ? (
            <StatusBadge status="draft" label="Changes not saved" />
          ) : (
            <StatusBadge status="published" />
          );
        },
      },
      {
        id: "size",
        header: "Page size",
        meta: { className: "hidden md:table-cell" },
        cell: (c) =>
          `${c.row.original.page_w_mm} × ${c.row.original.page_h_mm} mm`,
      },
      {
        id: "updated",
        header: "Updated",
        accessorFn: (r) => r.updated_at,
        enableSorting: true,
        meta: { className: "hidden md:table-cell" },
        cell: (c) => c.row.original.updated_at.slice(0, 10),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
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
                aria-label={`Save ${tpl.name} to the server`}
                title="Save to the server"
                disabled={syncing != null}
                onClick={() => handleSaveToServer(tpl)}
              >
                <CloudUpload className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Refresh ${tpl.name} from the server`}
                title="Refresh from the server"
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
                aria-label={`Delete ${tpl.name} everywhere`}
                title="Delete from the server and this computer"
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
                Edit
              </Button>
              <Button size="sm" onClick={() => handleUse(tpl, false)}>
                <Printer className="h-4 w-4" aria-hidden="true" />
                Print
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
        header: "Template",
        accessorFn: (r) => r.name.toLowerCase(),
        enableSorting: true,
        cell: (c) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{c.row.original.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {c.row.original.summary || "No summary"}
            </p>
          </div>
        ),
      },
      {
        id: "from",
        header: "Saved from",
        meta: { className: "hidden md:table-cell" },
        cell: (c) => c.row.original.origin_owner ?? "unknown",
      },
      {
        id: "status",
        header: "Status",
        cell: (c) =>
          c.row.original.withdrawn || gone.has(c.row.original.id) ? (
            <StatusBadge status="withdrawn" label="Withdrawn by author" />
          ) : (
            <StatusBadge status="saved" />
          ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
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
                aria-label={`Refresh ${tpl.name} from the server`}
                title="Refresh from the server"
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
                Print
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setRemoveTarget(tpl)}
              >
                Remove
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
      <PageHeader title="Templates" description={t("pages.templates")}>
        <Button variant="outline" onClick={() => setGetOpen(true)}>
          <CloudDownload className="h-4 w-4" aria-hidden="true" />
          Get from server
        </Button>
      </PageHeader>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="mine">Mine ({mine.length})</TabsTrigger>
          <TabsTrigger value="saved">Saved ({saved.length})</TabsTrigger>
          <TabsTrigger value="community">Community</TabsTrigger>
        </TabsList>

        {/* Mine */}
        <TabsContent value="mine" className="mt-4">
          {conflicts.length > 0 && (
            <div
              data-testid="conflict-banner"
              className="mb-4 flex items-center justify-between gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
            >
              <span>
                {conflicts.length === 1
                  ? `“${conflicts[0].name}” changed on another PC.`
                  : `${conflicts.length} templates changed on another PC.`}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setConflictIdx(0);
                  setConflictOpen(true);
                }}
              >
                Review
              </Button>
            </div>
          )}
          <DataTable
            caption="My templates"
            columns={mineColumns}
            data={mine}
            getRowId={(r) => String(r.id)}
            onRowActivate={(r) => navigate(`/template/${r.id}`)}
            empty={{
              title: "No templates yet",
              description: "Create one in Designer.",
              action: { label: "Open Designer", onClick: () => navigate("/") },
            }}
          />
        </TabsContent>

        {/* Saved */}
        <TabsContent value="saved" className="mt-4">
          <DataTable
            caption="Saved templates"
            columns={savedColumns}
            data={saved}
            getRowId={(r) => String(r.id)}
            empty={{
              title: "No saved templates",
              description:
                "Save a community template to keep a copy that works offline.",
              action: {
                label: "Browse community",
                onClick: () => setActiveTab("community"),
              },
            }}
          />
        </TabsContent>

        {/* Community gallery: previews matter here, so cards stay */}
        <TabsContent value="community" className="mt-4 space-y-4">
          <div className="flex flex-col gap-2 md:flex-row">
            <Input
              aria-label="Search templates"
              placeholder="Search by name"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1"
            />
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger
                aria-label="Sort templates"
                className="w-full md:w-[170px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="updated">Recently updated</SelectItem>
                <SelectItem value="used">Most used</SelectItem>
                <SelectItem value="name">A–Z</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={loadCommunity}>
              Refresh
            </Button>
          </div>

          {!configured ? (
            <Card>
              <EmptyState
                title="Share service not set up"
                description="Add a share service address in Settings to browse templates published by others."
                action={{
                  label: "Open Settings",
                  onClick: () => navigate("/settings"),
                }}
              />
            </Card>
          ) : offline ? (
            <Card>
              <EmptyState
                title="Can’t reach the share service"
                description="Community needs a network connection. Your saved templates still work offline."
                action={{ label: "Try again", onClick: loadCommunity }}
              />
            </Card>
          ) : communityLoading ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading…
            </p>
          ) : community.length === 0 ? (
            <Card>
              <EmptyState
                title="No published templates yet"
                description="Publish one from Designer to see it here."
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
                            <StatusBadge status="published" label="Yours" />
                          ) : (
                            <Badge variant="outline">Community</Badge>
                          )}
                        </div>
                        <p className="line-clamp-2 text-xs text-muted-foreground">
                          {tpl.summary || "No summary"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {tpl.owner_handle} · {tpl.use_count} prints ·{" "}
                          {tpl.page_w_mm}×{tpl.page_h_mm} mm
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
                                ? "Saving…"
                                : savedState
                                  ? "Saved"
                                  : "Save"}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openPreview(tpl)}
                          >
                            <Eye className="h-4 w-4" aria-hidden="true" />
                            Preview
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
        title={`Delete “${deleteTarget?.name ?? ""}” everywhere?`}
        description="The server copy and the copy on this computer are both deleted. This cannot be undone."
        confirmLabel="Delete template"
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
        title={`Refresh “${refreshTarget?.name ?? ""}” from the server?`}
        description="The copy on the server replaces the one on this computer, including changes you have not saved."
        confirmLabel="Refresh template"
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
        title={`Remove “${removeTarget?.name ?? ""}” from Saved?`}
        description="The local copy is deleted. You can save it again from Community."
        confirmLabel="Remove template"
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
                ? `${previewTpl.page_w_mm} × ${previewTpl.page_h_mm} mm, shown with sample data`
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
            <div className="max-h-[60vh] overflow-auto rounded-md border bg-muted p-4">
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
                  title="Template preview"
                />
              </div>
            </div>
          ) : (
            <p
              className="py-8 text-center text-sm text-muted-foreground"
              role="status"
            >
              Loading preview…
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewTpl(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
