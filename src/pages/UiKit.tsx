import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DataTable } from "@/components/DataTable";
import { PageHeader } from "@/components/PageHeader";
import { STATUS, StatusBadge, type StatusKey } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface Row {
  id: string;
  name: string;
  printer: string;
  status: StatusKey;
  copies: number;
}

const ROWS: Row[] = [
  { id: "1", name: "Shipping label 4x6", printer: "Dock Zebra", status: "success", copies: 12 },
  { id: "2", name: "Pick list A4", printer: "Office HP", status: "failed", copies: 1 },
  { id: "3", name: "Receipt 80 mm", printer: "Front desk", status: "queued", copies: 3 },
  { id: "4", name: "Pallet tag", printer: "Dock Zebra", status: "printing", copies: 40 },
];

const COLUMNS: ColumnDef<Row>[] = [
  { accessorKey: "name", header: "Template", enableSorting: true },
  { accessorKey: "printer", header: "Printer", enableSorting: true },
  { accessorKey: "copies", header: "Copies", enableSorting: true },
  { accessorKey: "status", header: "Status", cell: (c) => <StatusBadge status={c.getValue<StatusKey>()} /> },
];

/** Development-only reference for every primitive. Served at /__ui. */
export default function UiKitPage() {
  const [confirm, setConfirm] = useState(false);
  const [selected, setSelected] = useState<string>();
  return (
    <div className="space-y-6">
      <PageHeader title="UI kit" description="Every shared component in each state. Development only.">
        <Button variant="outline">Secondary action</Button>
        <Button>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Primary action
        </Button>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>Buttons</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Delete</Button>
          <Button size="sm">Small</Button>
          <Button size="lg">Large</Button>
          <Button disabled>Disabled</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {(Object.keys(STATUS) as StatusKey[]).map((k) => (
            <StatusBadge key={k} status={k} />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Form controls</CardTitle>
        </CardHeader>
        <CardContent className="grid max-w-md gap-3">
          <Input aria-label="Example input" placeholder="Printer name" />
          <Input aria-label="Disabled input" placeholder="Disabled" disabled />
        </CardContent>
      </Card>

      <section aria-labelledby="kit-table" className="space-y-2">
        <h2 id="kit-table" className="text-base font-semibold">
          Data table
        </h2>
        <DataTable
          caption="Example print jobs"
          columns={COLUMNS}
          data={ROWS}
          getRowId={(r) => r.id}
          selectedRowId={selected}
          onRowActivate={(r) => setSelected(r.id)}
        />
        <DataTable caption="Loading example" columns={COLUMNS} data={[]} loading />
        <DataTable
          caption="Empty example"
          columns={COLUMNS}
          data={[]}
          empty={{ title: "No print jobs yet", description: "Jobs appear here after you print." }}
        />
      </section>

      <Button variant="destructive" onClick={() => setConfirm(true)}>
        Delete template
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title='Delete "Shipping label 4x6"?'
        description="This removes the template from this computer. Published copies stay online."
        confirmLabel="Delete template"
        destructive
        onConfirm={() => setConfirm(false)}
      />
    </div>
  );
}
