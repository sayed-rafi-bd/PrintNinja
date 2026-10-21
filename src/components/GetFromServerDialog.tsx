import { useCallback, useEffect, useMemo, useState } from "react";
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
        `Added ${added} template${added === 1 ? "" : "s"} to this computer`,
      );
    if (already > 0)
      toast.success(
        `${already} template${already === 1 ? " is" : "s are"} already on this computer`,
      );
    for (const message of failed) toast.error(message);
    onDownloaded();
  };

  const columns = useMemo<ColumnDef<Row, any>[]>(
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
        id: "where",
        header: "Where",
        cell: (c) =>
          c.row.original.group === "Mine" ? (
            <StatusBadge status="published" label="Yours" />
          ) : (
            <StatusBadge status="saved" />
          ),
      },
      {
        id: "owner",
        header: "From",
        meta: { className: "hidden md:table-cell" },
        cell: (c) => (
          <span className="font-mono text-xs">
            {c.row.original.owner_handle}
          </span>
        ),
      },
      {
        id: "visibility",
        header: "Visibility",
        meta: { className: "hidden md:table-cell" },
        cell: (c) =>
          c.row.original.published_at ? (
            <StatusBadge status="published" label="In Community" />
          ) : (
            <StatusBadge status="draft" label="Private" />
          ),
      },
    ],
    [],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Get templates from the server</DialogTitle>
          <DialogDescription>
            Your templates and the ones you saved from Community, with their
            HTML, CSS and README.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Card>
            <EmptyState
              title="Can’t reach the server"
              description={`${error}. Templates already on this computer still print.`}
              action={{ label: "Try again", onClick: () => void load() }}
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
              title: "Nothing on the server yet",
              description:
                "Save a template to the server from Templates or the Designer, then it shows up here.",
            }}
          />
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={downloading}
          >
            Cancel
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
              ? "Adding…"
              : selected.size === 0
                ? "Add selected"
                : `Add ${selected.size} to this PC`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
