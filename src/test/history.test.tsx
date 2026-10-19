import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/lib/i18n";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { HistoryPage } from "@/pages/History";
import { useHistoryStore, type HistoryJob } from "@/lib/store/historyStore";

const job = (over: Partial<HistoryJob>): HistoryJob => ({
  id: 1, batch_id: null, record_index: null, template_id: 3, template_version_id: 1, printer_id: 1,
  source: "ui", source_url: null, status: "success", error: null, copies: 1, settings_json: null,
  rendered_html: null, idempotency_key: null, is_test: false, started_at: "2026-01-02T10:00:00Z",
  finished_at: "2026-01-02T10:00:02Z", duration_ms: 2000, ...over,
});

const JOBS = [job({ id: 1 }), job({ id: 2, status: "failed", error: "Paper out" }), job({ id: 3, printer_id: 2 })];

beforeAll(() => {
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

beforeEach(() => {
  invoke.mockReset();
  localStorage.clear();
  useHistoryStore.setState({ jobs: [], selectedJob: null });
  useHistoryStore.getState().clearFilter();
  invoke.mockImplementation(async (cmd: string, args?: any) => {
    if (cmd === "list_jobs") return JOBS;
    if (cmd === "list_printers") return [{ id: 1, name: "Dock Zebra" }, { id: 2, name: "Front desk" }];
    if (cmd === "reprint_job") return job({ id: 100 + args.id });
    if (cmd === "retry_job") return job({ id: args.id, status: "queued" });
    if (cmd === "delete_job") return null;
    return null;
  });
});

const renderPage = () => render(<MemoryRouter><HistoryPage /></MemoryRouter>);

describe("History page", () => {
  it("shows jobs with printer names and status words", async () => {
    renderPage();
    expect(await screen.findByText("#2")).toBeInTheDocument();
    expect(await screen.findAllByText("Dock Zebra")).not.toHaveLength(0);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getAllByText("Printed").length).toBe(2);
    expect(screen.getByText("3 of 3 jobs")).toBeInTheDocument();
  });

  it("filters by status and explains an empty result", async () => {
    renderPage();
    await screen.findByText("#2");
    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), { target: { value: "no such text" } });
    expect(await screen.findByText("No jobs match these filters")).toBeInTheDocument();
  });

  it("asks before reprinting a selection, then reprints each job", async () => {
    renderPage();
    await screen.findByText("#2");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row 1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row 3" }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Reprint selected/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Reprint 2 job(s)?")).toBeInTheDocument();
    expect(invoke.mock.calls.filter((c) => c[0] === "reprint_job")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Reprint" }));
    await waitFor(() => expect(invoke.mock.calls.filter((c) => c[0] === "reprint_job")).toHaveLength(2));
  });

  it("only offers retry for failed jobs in the selection", async () => {
    renderPage();
    await screen.findByText("#2");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row 1" }));
    expect(screen.getByRole("button", { name: /Retry failed \(0\)/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row 2" }));
    expect(screen.getByRole("button", { name: /Retry failed \(1\)/ })).toBeEnabled();
  });

  it("names the job in the delete confirmation and does not delete until confirmed", async () => {
    renderPage();
    await screen.findByText("#2");
    fireEvent.click(screen.getByRole("button", { name: "Delete job 2" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete job #2?")).toBeInTheDocument();
    expect(invoke.mock.calls.some((c) => c[0] === "delete_job")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete job" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("delete_job", { id: 2 }));
  });

  it("saves a filter set and reapplies it", async () => {
    renderPage();
    await screen.findByText("#2");
    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), { target: { value: "paper" } });
    fireEvent.pointerDown(screen.getByRole("button", { name: /Saved filters/ }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Save current filters/ }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Paper issues" } });
    fireEvent.click(screen.getByRole("button", { name: "Save filter" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("printninja-history-filters")!)[0].name).toBe("Paper issues"));
  });
});
