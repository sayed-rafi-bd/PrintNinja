import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface DataTableProps<T> {
  /** Accessible name for the table, read by screen readers. */
  caption: string;
  columns: ColumnDef<T, any>[];
  data: T[];
  getRowId?: (row: T, index: number) => string;
  loading?: boolean;
  empty?: {
    title: string;
    description?: string;
    action?: { label: string; onClick: () => void };
  };
  /** Called on click, Enter, or Space. Makes rows focusable and arrow-key navigable. */
  onRowActivate?: (row: T) => void;
  selectedRowId?: string;
  /** Adds a checkbox column. Ids come from `getRowId`. */
  selection?: {
    selectedIds: ReadonlySet<string>;
    onChange: (ids: Set<string>) => void;
  };
  /** Scroll the body inside this height and keep the header visible. */
  maxHeight?: string;
  className?: string;
  footer?: ReactNode;
}

const SKELETON_ROWS = 5;

/** The checkbox itself stays small; this padded label makes the touch target ~40px. */
const CHECK_HIT =
  "-m-2.5 inline-flex cursor-pointer items-center justify-center p-2.5";

/** Per-column responsive classes, e.g. `{ meta: { className: "hidden md:table-cell" } }`. */
const metaClass = (col: {
  columnDef: { meta?: unknown };
}): string | undefined =>
  (col.columnDef.meta as { className?: string } | undefined)?.className;

export function DataTable<T>({
  caption,
  columns,
  data,
  getRowId,
  loading = false,
  empty = { title: "Nothing to show" },
  onRowActivate,
  selectedRowId,
  selection,
  maxHeight,
  className,
  footer,
}: DataTableProps<T>) {
  const { t } = useTranslation();
  const [sorting, setSorting] = useState<SortingState>([]);
  // Sorting is opt in per column: `enableSorting: true`.
  const cols = useMemo(() => {
    const base = columns.map((c) => ({ enableSorting: false, ...c }));
    if (!selection) return base;
    const check: ColumnDef<T, unknown> = {
      id: "__select",
      size: 36,
      enableSorting: false,
      header: () => null,
      cell: () => null,
    };
    return [check, ...base];
  }, [columns, selection]);
  const table = useReactTable({
    data,
    columns: cols,
    getRowId,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const colCount = table.getVisibleLeafColumns().length;
  const rows = table.getRowModel().rows;

  const onKeyDown = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (!onRowActivate) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onRowActivate(row);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const sibling =
        e.key === "ArrowDown"
          ? e.currentTarget.nextElementSibling
          : e.currentTarget.previousElementSibling;
      if (sibling instanceof HTMLElement) sibling.focus();
    }
  };

  return (
    <div className={cn("rounded-lg border bg-card", className)}>
      <div
        className="overflow-auto"
        style={maxHeight ? { maxHeight } : undefined}
      >
        <Table>
          <caption className="sr-only">{caption}</caption>
          <TableHeader className="sticky top-0 z-10 bg-card shadow-[0_1px_0_hsl(var(--border))]">
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  const canSort = header.column.getCanSort();
                  return (
                    <TableHead
                      key={header.id}
                      className={metaClass(header.column)}
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : undefined
                      }
                      style={
                        header.getSize() !== 150
                          ? { width: header.getSize() }
                          : undefined
                      }
                    >
                      {header.column.id === "__select" && selection ? (
                        <label className={CHECK_HIT}>
                          <input
                            type="checkbox"
                            aria-label={t("common.select_all_rows")}
                            className="h-5 w-5 accent-primary"
                            checked={
                              rows.length > 0 &&
                              rows.every((r) => selection.selectedIds.has(r.id))
                            }
                            ref={(el) => {
                              if (el)
                                el.indeterminate =
                                  rows.some((r) =>
                                    selection.selectedIds.has(r.id),
                                  ) &&
                                  !rows.every((r) =>
                                    selection.selectedIds.has(r.id),
                                  );
                            }}
                            onChange={(e) =>
                              selection.onChange(
                                e.target.checked
                                  ? new Set([
                                      ...selection.selectedIds,
                                      ...rows.map((r) => r.id),
                                    ])
                                  : new Set(
                                      [...selection.selectedIds].filter(
                                        (id) => !rows.some((r) => r.id === id),
                                      ),
                                    ),
                              )
                            }
                          />
                        </label>
                      ) : header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="inline-flex min-h-9 items-center gap-1 rounded-sm hover:text-foreground"
                          aria-label={t("common.sort_by", {
                            column:
                              typeof header.column.columnDef.header === "string"
                                ? header.column.columnDef.header
                                : header.column.id,
                          })}
                        >
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                          {sorted === "asc" ? (
                            <ArrowUp
                              className="h-3.5 w-3.5"
                              aria-hidden="true"
                            />
                          ) : sorted === "desc" ? (
                            <ArrowDown
                              className="h-3.5 w-3.5"
                              aria-hidden="true"
                            />
                          ) : (
                            <ChevronsUpDown
                              className="h-3.5 w-3.5 opacity-60"
                              aria-hidden="true"
                            />
                          )}
                        </button>
                      ) : (
                        flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: SKELETON_ROWS }, (_, i) => (
                <TableRow
                  key={i}
                  className="hover:bg-transparent"
                  aria-hidden="true"
                >
                  {Array.from({ length: colCount }, (_, c) => (
                    <TableCell key={c}>
                      <Skeleton className="h-4 w-full max-w-[12rem]" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={colCount}>
                  <EmptyState {...empty} className="py-10" />
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={selectedRowId === row.id ? "selected" : undefined}
                  aria-selected={
                    onRowActivate ? selectedRowId === row.id : undefined
                  }
                  tabIndex={onRowActivate ? 0 : undefined}
                  className={cn(
                    onRowActivate && "cursor-pointer focus-visible:bg-accent",
                  )}
                  onClick={
                    onRowActivate
                      ? () => onRowActivate(row.original)
                      : undefined
                  }
                  onKeyDown={(e) => onKeyDown(e, row.original)}
                >
                  {row.getVisibleCells().map((cell) =>
                    cell.column.id === "__select" && selection ? (
                      <TableCell
                        key={cell.id}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <label className={CHECK_HIT}>
                          <input
                            type="checkbox"
                            aria-label={t("common.select_row", { id: row.id })}
                            className="h-5 w-5 accent-primary"
                            checked={selection.selectedIds.has(row.id)}
                            onChange={(e) => {
                              const next = new Set(selection.selectedIds);
                              if (e.target.checked) next.add(row.id);
                              else next.delete(row.id);
                              selection.onChange(next);
                            }}
                          />
                        </label>
                      </TableCell>
                    ) : (
                      <TableCell
                        key={cell.id}
                        className={metaClass(cell.column)}
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </TableCell>
                    ),
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {footer && (
        <div className="border-t px-3 py-2 text-xs text-muted-foreground">
          {footer}
        </div>
      )}
    </div>
  );
}
