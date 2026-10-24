import {
  useMemo,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type Row,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { PHONE_QUERY, useMediaQuery } from "@/lib/hooks/useMediaQuery";
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
  /**
   * Phone card layout: when provided and the viewport is
   * below `md`, rows render as cards instead of a table. Desktop, jsdom and
   * e2e keep the table, so existing queries are unaffected.
   */
  renderCard?: (row: T) => ReactNode;
  /** Controlled sorting for phone-only sort dropdowns; uncontrolled by default. */
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
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
  empty,
  onRowActivate,
  selectedRowId,
  selection,
  maxHeight,
  className,
  footer,
  renderCard,
  sorting: sortingProp,
  onSortingChange: onSortingChangeProp,
}: DataTableProps<T>) {
  const { t } = useTranslation();
  // Default empty title, overridable per table.
  const emptyState = { title: t("common.empty"), ...empty };
  // Uncontrolled by default; pages with a phone sort dropdown pass these in.
  const [internalSorting, setInternalSorting] = useState<SortingState>([]);
  const sorting = sortingProp ?? internalSorting;
  const handleSortingChange = onSortingChangeProp ?? setInternalSorting;
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
    onSortingChange: handleSortingChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  // Phone card mode, gated on JS like the phase-1 phone layouts: jsdom has
  // no matchMedia, so unit tests and desktop e2e always see the table below.
  const isPhone = useMediaQuery(PHONE_QUERY);
  const cardMode = isPhone && renderCard != null;

  const colCount = table.getVisibleLeafColumns().length;
  const rows = table.getRowModel().rows;

  const onKeyDown = (e: KeyboardEvent<HTMLElement>, row: T) => {
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

  // Cards navigate between list items instead of sibling rows.
  const onCardKeyDown = (e: KeyboardEvent<HTMLElement>, row: T) => {
    if (!onRowActivate) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onRowActivate(row);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const item = e.currentTarget.closest("li");
      const sibling =
        e.key === "ArrowDown"
          ? item?.nextElementSibling
          : item?.previousElementSibling;
      const target =
        sibling instanceof HTMLElement
          ? sibling.querySelector<HTMLElement>("[data-card]")
          : null;
      target?.focus();
    }
  };

  // One selection checkbox, shared by the table column and the card layout
  // so both keep the same `Select row <id>` accessible names.
  const selectBox = (row: Row<T>) =>
    selection ? (
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
    ) : null;

  const stop = {
    onClick: (e: MouseEvent) => e.stopPropagation(),
    onKeyDown: (e: KeyboardEvent) => e.stopPropagation(),
  };

  if (cardMode && renderCard) {
    return (
      <div className={cn("space-y-2", className)}>
        {loading ? (
          <div aria-hidden="true" className="space-y-2">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="rounded-lg border bg-card p-3">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="mt-2 h-4 w-1/3" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border bg-card">
            <EmptyState {...emptyState} className="py-10" />
          </div>
        ) : (
          <ul
            aria-label={caption}
            className="space-y-2 overflow-auto"
            style={maxHeight ? { maxHeight } : undefined}
          >
            {rows.map((row) => (
              <li key={row.id}>
                <div
                  data-card=""
                  data-state={selectedRowId === row.id ? "selected" : undefined}
                  tabIndex={onRowActivate ? 0 : undefined}
                  className={cn(
                    "flex gap-1 rounded-lg border bg-card p-3",
                    onRowActivate &&
                      "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    selectedRowId === row.id && "bg-accent",
                  )}
                  onClick={
                    onRowActivate
                      ? () => onRowActivate(row.original)
                      : undefined
                  }
                  onKeyDown={(e) => onCardKeyDown(e, row.original)}
                >
                  {selection && (
                    <span {...stop} className="flex shrink-0 pt-0.5">
                      {selectBox(row)}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    {renderCard(row.original)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {footer && (
          <div className="text-xs text-muted-foreground">{footer}</div>
        )}
      </div>
    );
  }

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
                          className="inline-flex min-h-9 items-center gap-1 rounded-sm hover:text-foreground [@media(pointer:coarse)]:min-h-11"
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
                  <EmptyState {...emptyState} className="py-10" />
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
                      <TableCell key={cell.id} {...stop}>
                        {selectBox(row)}
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
