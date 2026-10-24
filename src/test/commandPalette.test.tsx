import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@/lib/i18n";
import { CommandPalette } from "@/components/CommandPalette";

const mockAgent = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agent/commands", () => ({
  agent: (...args: unknown[]) => mockAgent(...args),
}));

const printers = [
  {
    id: 1,
    name: "Dock Zebra",
    address: "192.168.1.50:9100",
    printer_type: "raw_tcp",
    language: "zpl",
  },
];

const jobs = [
  {
    id: 42,
    batch_id: null,
    record_index: null,
    template_id: 3,
    printer_id: 1,
    source: "ui",
    source_url: null,
    status: "success",
    error: null,
    copies: 1,
    settings_json: null,
    rendered_html: null,
  },
];

beforeEach(() => {
  mockAgent.mockReset().mockImplementation((cmd: string) => {
    if (cmd === "list_templates") return Promise.resolve([]);
    if (cmd === "list_printers") return Promise.resolve(printers);
    if (cmd === "list_jobs") return Promise.resolve(jobs);
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
});

function headings() {
  return [...document.querySelectorAll("[cmdk-group-heading]")].map(
    (el) => el.textContent,
  );
}

function show(props?: {
  onNavigate?: (p: string) => void;
  onReprintJob?: (id: number) => void;
}) {
  return render(
    <CommandPalette
      open
      onOpenChange={() => {}}
      onNavigate={props?.onNavigate ?? (() => {})}
      onReprintLast={() => {}}
      onReprintJob={props?.onReprintJob ?? (() => {})}
    />,
  );
}

describe("CommandPalette search coverage", () => {
  it("lists printers and navigates to the printers page", async () => {
    const onNavigate = vi.fn();
    show({ onNavigate });
    await screen.findByText("Dock Zebra");
    expect(headings()).toContain("Printers");
    fireEvent.click(screen.getByText("Dock Zebra"));
    expect(onNavigate).toHaveBeenCalledWith("/printers");
  });

  it("lists recent jobs and offers a per-job reprint", async () => {
    const onReprintJob = vi.fn();
    show({ onReprintJob });
    await screen.findByText("Reprint job #42");
    expect(headings()).toContain("Recent jobs");
    fireEvent.click(screen.getByText("Reprint job #42"));
    expect(onReprintJob).toHaveBeenCalledWith(42);
  });

  it("lists settings sections and deep-links to them", async () => {
    const onNavigate = vi.fn();
    show({ onNavigate });
    await screen.findByText("API and automation");
    expect(headings()).toContain("Settings");
    fireEvent.click(screen.getByText("API and automation"));
    expect(onNavigate).toHaveBeenCalledWith("/settings?section=api");
  });

  it("stays silent when a list call fails", async () => {
    mockAgent.mockImplementation((cmd: string) =>
      cmd === "list_templates"
        ? Promise.resolve([])
        : Promise.reject(new Error("down")),
    );
    show();
    await waitFor(() => expect(headings()).not.toContain("Printers"));
    // Pages and actions still work.
    expect(screen.getByText("Go to")).toBeInTheDocument();
  });
});
