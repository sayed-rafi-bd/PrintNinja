import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computePrintLayout } from "@/lib/render/printLayout";

// The other half of the print layout contract: the same
// src-tauri/tests/fixtures/layout_cases.json that the Rust suite
// (tests/layout_parity.rs) runs against `render::layout::compute`. The
// preview and the PDF must place the design identically.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    join(here, "../../src-tauri/tests/fixtures/layout_cases.json"),
    "utf8",
  ),
) as {
  cases: {
    name: string;
    fit_mode: string;
    design: [number, number];
    paper: [number, number];
    margins: { top: number; right: number; bottom: number; left: number };
    expect: {
      scale: number;
      content: [number, number, number, number];
      placements: [number, number][];
    };
  }[];
};

describe("computePrintLayout matches the shared fixture", () => {
  it("has cases", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_n, c) => {
    const l = computePrintLayout(
      c.fit_mode,
      c.design[0],
      c.design[1],
      c.paper[0],
      c.paper[1],
      c.margins,
    );
    // The fixture stores four decimals.
    expect(l.scale).toBeCloseTo(c.expect.scale, 3);
    expect(l.contentX).toBeCloseTo(c.expect.content[0], 3);
    expect(l.contentY).toBeCloseTo(c.expect.content[1], 3);
    expect(l.contentW).toBeCloseTo(c.expect.content[2], 3);
    expect(l.contentH).toBeCloseTo(c.expect.content[3], 3);
    expect(l.placements).toHaveLength(c.expect.placements.length);
    l.placements.forEach((p, i) => {
      expect(p.offsetX).toBeCloseTo(c.expect.placements[i][0], 3);
      expect(p.offsetY).toBeCloseTo(c.expect.placements[i][1], 3);
    });
  });
});

describe("computePrintLayout rules", () => {
  const m = { top: 5, right: 5, bottom: 5, left: 5 };

  it("never changes the aspect ratio, in any fit mode", () => {
    for (const mode of ["actual", "fit-width", "fit-page", "shrink", "fill"]) {
      const l = computePrintLayout(mode, 102, 102, 210, 297, m);
      expect(l.drawW).toBeCloseTo(l.drawH, 9);
    }
  });

  it("treats the design as its full size, margins only shrink the paper", () => {
    const l = computePrintLayout("fit-width", 102, 102, 210, 297, m);
    expect(l.scale).toBeCloseTo((210 - 10) / 102, 9);
  });

  it("scales a design to exactly 1 when it fills the content box", () => {
    const zero = { top: 0, right: 0, bottom: 0, left: 0 };
    for (const mode of ["fit-width", "fit-page", "fill", "shrink", "actual"]) {
      expect(computePrintLayout(mode, 100, 200, 100, 200, zero).scale).toBe(1);
    }
  });

  it("does not return -0 offsets", () => {
    const l = computePrintLayout("fit-width", 80, 400, 210, 297, m);
    expect(Object.is(l.placements[0].offsetY, -0)).toBe(false);
  });
});
