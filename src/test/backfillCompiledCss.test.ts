import { describe, it, expect, vi, beforeEach } from "vitest";
import { templateCssKey } from "@/lib/templates/compileTemplateCss";

const invoke = vi.fn();
vi.mock("@/lib/invoke", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const HTML = `<p class="w-[37mm] flex">x</p>`;

interface Row {
  id: number;
  html: string;
  compiled_css?: string;
  compiled_key?: string;
}

function backend(versionsByTemplate: Record<number, Row[]>) {
  invoke.mockImplementation((cmd: string, args?: any) => {
    if (cmd === "list_templates") {
      return Promise.resolve(Object.keys(versionsByTemplate).map((id) => ({ id: +id })));
    }
    if (cmd === "list_versions") return Promise.resolve(versionsByTemplate[args.templateId]);
    if (cmd === "set_version_compiled_css") return Promise.resolve(null);
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
}

const writes = () =>
  invoke.mock.calls.filter((c) => c[0] === "set_version_compiled_css").map((c) => c[1].req);

describe("backfillCompiledCss", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.resetModules();
  });

  it("compiles versions that have no compiled CSS", async () => {
    backend({ 1: [{ id: 10, html: HTML }, { id: 11, html: HTML, compiled_css: "", compiled_key: "" }] });
    const { backfillCompiledCss } = await import("@/lib/templates/backfillCompiledCss");

    expect(await backfillCompiledCss()).toBe(2);
    const w = writes();
    expect(w.map((r) => r.id)).toEqual([10, 11]);
    expect(w[0].compiled_key).toBe(templateCssKey(HTML));
    expect(w[0].compiled_css).toContain("37mm");
  });

  it("leaves versions that are already up to date alone", async () => {
    backend({
      1: [{ id: 10, html: HTML, compiled_css: ".x{}", compiled_key: templateCssKey(HTML) }],
    });
    const { backfillCompiledCss } = await import("@/lib/templates/backfillCompiledCss");

    expect(await backfillCompiledCss()).toBe(0);
    expect(writes()).toEqual([]);
  });

  it("recompiles when the stored key is from another compiler revision or class set", async () => {
    backend({
      1: [
        { id: 10, html: HTML, compiled_css: ".old{}", compiled_key: "tw3.0-r0:deadbeef" },
        { id: 11, html: `<i class="m-1">y</i>`, compiled_css: ".old{}", compiled_key: templateCssKey(HTML) },
      ],
    });
    const { backfillCompiledCss } = await import("@/lib/templates/backfillCompiledCss");

    expect(await backfillCompiledCss()).toBe(2);
    expect(writes().map((r) => r.id)).toEqual([10, 11]);
  });

  it("walks every template", async () => {
    backend({ 1: [{ id: 10, html: HTML }], 2: [{ id: 20, html: HTML }] });
    const { backfillCompiledCss } = await import("@/lib/templates/backfillCompiledCss");
    expect(await backfillCompiledCss()).toBe(2);
    expect(writes().map((r) => r.id)).toEqual([10, 20]);
  });

  it("never throws when the backend fails", async () => {
    invoke.mockRejectedValue(new Error("no backend"));
    const { backfillCompiledCss } = await import("@/lib/templates/backfillCompiledCss");
    await expect(backfillCompiledCss()).resolves.toBe(0);
  });

  it("ensureCompiledCss runs the backfill once per session", async () => {
    backend({ 1: [{ id: 10, html: HTML }] });
    const { ensureCompiledCss } = await import("@/lib/templates/backfillCompiledCss");
    await Promise.all([ensureCompiledCss(), ensureCompiledCss()]);
    await ensureCompiledCss();
    expect(invoke.mock.calls.filter((c) => c[0] === "list_templates")).toHaveLength(1);
  });
});
