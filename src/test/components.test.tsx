import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";
import "@/lib/i18n";
import {
  STATUS,
  StatusBadge,
  JobStatusBadge,
  isStatusKey,
} from "@/components/StatusBadge";
import { PageHeader } from "@/components/PageHeader";
import { DataTable } from "@/components/DataTable";
import { ConfirmDialog } from "@/components/ConfirmDialog";

describe("StatusBadge", () => {
  it("renders a word and an icon for every state, never colour alone", () => {
    for (const key of Object.keys(STATUS) as Array<keyof typeof STATUS>) {
      const { container, unmount } = render(<StatusBadge status={key} />);
      expect(container.textContent?.trim().length).toBeGreaterThan(0);
      expect(container.querySelector("svg[aria-hidden='true']")).not.toBeNull();
      unmount();
    }
  });

  it("maps job statuses to the shared vocabulary", () => {
    render(<JobStatusBadge status="success" />);
    expect(screen.getByText("Printed")).toBeInTheDocument();
  });

  it("falls back to a neutral chip for unknown data values", () => {
    render(<JobStatusBadge status="mystery" />);
    expect(screen.getByText("mystery").className).toContain("text-neutral");
    expect(isStatusKey("mystery")).toBe(false);
  });

  it("allows a label override without changing the tone", () => {
    render(<StatusBadge status="published" label="Yours" />);
    const el = screen.getByText("Yours");
    expect(el.className).toContain("text-success");
  });
});

describe("PageHeader", () => {
  it("renders one h1, a description, and actions", () => {
    render(
      <PageHeader title="History" description="Review jobs.">
        <button type="button">Export</button>
      </PageHeader>,
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("Review jobs.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
  });
});

interface Row {
  id: string;
  name: string;
  n: number;
}
const columns: ColumnDef<Row>[] = [
  { accessorKey: "name", header: "Name", enableSorting: true },
  { accessorKey: "n", header: "Count", enableSorting: true },
];
const rows: Row[] = [
  { id: "a", name: "Bravo", n: 2 },
  { id: "b", name: "Alpha", n: 3 },
];

describe("DataTable", () => {
  it("has an accessible name and renders rows", () => {
    render(<DataTable caption="Jobs" columns={columns} data={rows} />);
    expect(screen.getByRole("table", { name: "Jobs" })).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("shows an empty state with guidance", () => {
    render(
      <DataTable
        caption="Jobs"
        columns={columns}
        data={[]}
        empty={{ title: "No jobs yet", description: "Print something." }}
      />,
    );
    expect(screen.getByText("No jobs yet")).toBeInTheDocument();
    expect(screen.getByText("Print something.")).toBeInTheDocument();
  });

  it("hides data and rows while loading", () => {
    render(<DataTable caption="Jobs" columns={columns} data={rows} loading />);
    expect(screen.queryByText("Bravo")).toBeNull();
  });

  it("sorts when a sortable header is clicked and reports aria-sort", () => {
    render(<DataTable caption="Jobs" columns={columns} data={rows} />);
    const sort = screen.getByRole("button", { name: "Sort by Name" });
    fireEvent.click(sort);
    const cells = screen
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.textContent);
    expect(cells[0]).toContain("Alpha");
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
  });

  it("names the selection checkboxes for assistive tech", () => {
    render(
      <DataTable
        caption="Jobs"
        columns={columns}
        data={rows}
        getRowId={(r) => r.id}
        selection={{ selectedIds: new Set(), onChange: () => {} }}
      />,
    );
    expect(
      screen.getByRole("checkbox", { name: "Select all rows" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Select row a" }),
    ).toBeInTheDocument();
  });

  it("activates rows by click, Enter, and moves focus with arrow keys", () => {
    const onActivate = vi.fn();
    render(
      <DataTable
        caption="Jobs"
        columns={columns}
        data={rows}
        getRowId={(r) => r.id}
        onRowActivate={onActivate}
      />,
    );
    const [, first, second] = screen.getAllByRole("row");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: "Enter" });
    expect(onActivate).toHaveBeenCalledWith(rows[1]);
    fireEvent.click(first);
    expect(onActivate).toHaveBeenCalledWith(rows[0]);
  });
});

describe("ConfirmDialog", () => {
  it("names the item and confirms with the primary action", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title='Delete "Pallet tag"?'
        confirmLabel="Delete template"
        destructive
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByText('Delete "Pallet tag"?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete template" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
