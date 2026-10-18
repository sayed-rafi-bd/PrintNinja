import { describe, it, expect, vi, beforeEach } from "vitest";
import { STARTER_TEMPLATES } from "@/lib/templates/defaultTemplate";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

describe("ensureStarterTemplates", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.resetModules();
  });

  it("persists the bundled starters when the database has none", async () => {
    invoke
      // list_templates comes back empty on a fresh install
      .mockResolvedValueOnce([])
      .mockImplementation((cmd: string) => {
        if (cmd === "create_template") {
          return Promise.resolve({
            id: 1,
            name: "Receipt 120mm",
            page_w_mm: 120,
            page_h_mm: 200,
            orientation: "portrait",
          });
        }
        return Promise.resolve([]);
      });

    const { ensureStarterTemplates } = await import(
      "@/lib/templates/seedTemplates"
    );
    const rows = await ensureStarterTemplates();

    // Every starter must reach the database, otherwise the Print tab's
    // dropdown is empty and shows "No templates — create one in Designer".
    const created = invoke.mock.calls.filter(
      (c) => c[0] === "create_template",
    );
    expect(created).toHaveLength(STARTER_TEMPLATES.length);
    expect(rows.length).toBeGreaterThan(0);

    // The seeded request must carry the real html/css so version 1 is
    // renderable rather than an empty document.
    for (const starter of STARTER_TEMPLATES) {
      const match = created.find(
        (c) => (c[1] as { req: { name: string } }).req.name === starter.name,
      );
      expect(match, `missing starter: ${starter.name}`).toBeDefined();
      const req = (match![1] as { req: Record<string, unknown> }).req;
      expect(req.html).toBe(starter.html);
      expect(req.css).toBe(starter.css);
      expect(req.page_w_mm).toBe(starter.page_w_mm);
      expect(req.page_h_mm).toBe(starter.page_h_mm);
    }
  });

  it("does not re-seed when templates already exist", async () => {
    const existing = [
      { id: 7, name: "My Template", page_w_mm: 100, page_h_mm: 150, orientation: "portrait" },
    ];
    invoke.mockResolvedValue(existing);

    const { ensureStarterTemplates } = await import(
      "@/lib/templates/seedTemplates"
    );
    const rows = await ensureStarterTemplates();

    expect(rows).toEqual(existing);
    expect(
      invoke.mock.calls.filter((c) => c[0] === "create_template"),
    ).toHaveLength(0);
  });

  it("dedupes concurrent callers so starters are created once", async () => {
    invoke.mockResolvedValue([]).mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "create_template"
          ? { id: 1, name: "x", page_w_mm: 1, page_h_mm: 1, orientation: "portrait" }
          : [],
      ),
    );

    const { ensureStarterTemplates } = await import(
      "@/lib/templates/seedTemplates"
    );
    const [a, b] = await Promise.all([
      ensureStarterTemplates(),
      ensureStarterTemplates(),
    ]);

    expect(a).toBe(b);
    expect(invoke.mock.calls.filter((c) => c[0] === "list_templates")).toHaveLength(1);
  });

  it("returns an empty list in web mode instead of throwing", async () => {
    invoke.mockRejectedValue(new Error("no Tauri backend"));

    const { ensureStarterTemplates } = await import(
      "@/lib/templates/seedTemplates"
    );
    await expect(ensureStarterTemplates()).resolves.toEqual([]);
  });
});
