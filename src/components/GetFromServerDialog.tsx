import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ColumnDef } from "@tanstack/react-table";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { StatusBadge } from "@/components/StatusBadge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import type { RemoteTemplateSummary } from "@/lib/share/client";
import {
  downloadToLocal,
  listAvailableRemoteTemplates,
} from "@/lib/share/sync";

type Row = RemoteTemplateSummary & { group: "Mine" | "Saved" };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after templates land on this PC, so the page can reload them. */
  onDownloaded: () => void;
}

/**
 * Put templates from the server on this computer: the user's own, and the ones
 * they saved from Community. How a new PC gets the templates it is missing.
 */
export function GetFromServerDialog({
  open,
  onOpenChange,
  onDownloaded,
}: Props) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const { t } = useTranslation();

  const load = useCallback(async () => {
    setRows(null);
    setError(null);
    try {
      const { mine, saved } = await listAvailableRemoteTemplates();
      setRows([
        ...mine.map((t) => ({ ...t, group: "Mine" as const })),
        ...saved.map((t) => ({ ...t, group: "Saved" as const })),
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (open) {
      setSelected(new Set());
      void load();
    }
  }, [open, load]);

  const byId = useMemo(
    () => new Map((rows ?? []).map((r) => [r.id, r])),
    [rows],
  );

  const handleDownload = async () => {
    const wanted = [...selected]
      .map((id) => byId.get(id))
      .filter((r): r is Row => !!r);
    if (wanted.length === 0) return;
    setDownloading(true);
    let added = 0;
    let already = 0;
    const failed: string[] = [];
    for (const row of wanted) {
      try {
        const result = await downloadToLocal(
          row.id,
          row.group === "Saved" ? "saved" : "own",
          row.owner_handle,
        );
        if (result.created) added += 1;
        else already += 1;
      } catch (e) {
        failed.push(e instanceof Error ? e.message : String(e));
      }
    }
    setDownloading(false);
    onOpenChange(false);
    if (added > 0)
      toast.success(
        t("templates.server_added", {
          count: added,
          plural: added === 1 ? "" : "s",
        }),
      );
    if (already > 0)
      toast.success(
        t("templates.server_already", {
          count: already,
          plural: already === 1 ? "" : "s",
          verb:
            already === 1
              ? t("templates.server_is")
              : t("templates.server_are"),
        }),
      );
    for (const message of failed) toast.error(message);
    onDownloaded();
  };

  const columns = useMemo<ColumnDef<Row, any>[]>(
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
        id: "where",
        header: t("templates.server_col_where"),
        cell: (c) =>
          c.row.original.group === "Mine" ? (
            <StatusBadge
              status="published"
              label={t("templates.server_mine")}
            />
          ) : (
            <StatusBadge status="saved" />
          ),
      },
      {
        id: "owner",
        header: t("templates.server_col_from"),
        meta: { className: "hidden md:table-cell" },
        cell: (c) => (
          <span className="font-mono text-xs">
            {c.row.original.owner_handle}
          </span>
        ),
      },
      {
        id: "visibility",
        header: t("templates.server_col_visibility"),
        meta: { className: "hidden md:table-cell" },
        cell: (c) =>
          c.row.original.published_at ? (
            <StatusBadge
              status="published"
              label={t("templates.server_in_community")}
            />
          ) : (
            <StatusBadge status="draft" label={t("templates.status_private")} />
          ),
      },
    ],
    [t],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("templates.server_title")}</DialogTitle>
          <DialogDescription>
            {t("templates.server_description")}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Card>
            <EmptyState
              title={t("templates.server_unreachable")}
              description={t("templates.server_unreachable_hint", {
                error,
              })}
              action={{
                label: t("templates.server_retry"),
                onClick: () => void load(),
              }}
            />
          </Card>
        ) : (
          <DataTable
            caption="Templates on the server"
            columns={columns}
            data={rows ?? []}
            getRowId={(r) => r.id}
            loading={rows == null}
            selection={{ selectedIds: selected, onChange: setSelected }}
            maxHeight="50vh"
            empty={{
              title: t("templates.server_empty"),
              description: t("templates.server_empty_hint"),
            }}
          />
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={downloading}
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => void handleDownload()}
            disabled={
              downloading ||
              selected.size === 0 ||
              rows == null ||
              rows.length === 0
            }
          >
            {downloading
              ? t("templates.server_adding")
              : selected.size === 0
                ? t("templates.server_add_selected")
                : t("templates.server_add_count", { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
