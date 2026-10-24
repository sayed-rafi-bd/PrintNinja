import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PrintPreview } from "@/components/PrintPreview";

const MM = 3.7795;
const margins = { top: 5, right: 5, bottom: 5, left: 5 };

function setup(over: Partial<React.ComponentProps<typeof PrintPreview>> = {}) {
  return render(
    <PrintPreview
      pages={["<p>one</p>"]}
      designW={102}
      designH={102}
      paperW={210}
      paperH={297}
      margins={margins}
      fitMode="fit-page"
      title="Print preview"
      {...over}
    />,
  );
}

const px = (v: string) => Number.parseFloat(v);

describe("PrintPreview", () => {
  it("draws the sheet at the paper size", () => {
    setup();
    const sheet = screen.getByTestId("print-sheet");
    expect(px(sheet.style.width)).toBeCloseTo(210 * MM, 1);
    expect(px(sheet.style.height)).toBeCloseTo(297 * MM, 1);
  });

  it("keeps the design frame at the Designer's size and scales it with a transform", () => {
    setup();
    const frame = screen.getByTitle("Print preview");
    // Same px size the Designer canvas gives a 102 x 102 mm page.
    expect(px(frame.style.width)).toBeCloseTo(102 * MM, 1);
    expect(px(frame.style.height)).toBeCloseTo(102 * MM, 1);
    // fit-page on A4 with 5 mm margins: 200 / 102.
    expect(frame.style.transform).toBe(`scale(${200 / 102})`);
  });

  it("keeps the aspect ratio of a square design in every fit mode", () => {
    for (const mode of ["actual", "fit-width", "fit-page", "shrink", "fill"]) {
      const { unmount } = setup({ fitMode: mode });
      const frame = screen.getByTitle("Print preview");
      expect(px(frame.style.width)).toBeCloseTo(px(frame.style.height), 3);
      unmount();
    }
  });

  it("scales differently per fit mode", () => {
    const scale = (mode: string) => {
      const { unmount } = setup({ fitMode: mode });
      const v = screen.getByTestId("print-preview").dataset.scale;
      unmount();
      return Number(v);
    };
    expect(scale("actual")).toBe(1);
    expect(scale("shrink")).toBe(1);
    expect(scale("fit-width")).toBeCloseTo(200 / 102, 3);
    expect(scale("fit-page")).toBeCloseTo(200 / 102, 3);
    expect(scale("fill")).toBeCloseTo(287 / 102, 3);
  });

  it("clips to the printable area inside the margins", () => {
    setup({ margins: { top: 10, right: 20, bottom: 30, left: 40 } });
    const area = screen.getByTitle("Print preview")
      .parentElement as HTMLElement;
    expect(area.className).toContain("overflow-hidden");
    expect(px(area.style.left)).toBeCloseTo(40 * MM, 1);
    expect(px(area.style.top)).toBeCloseTo(10 * MM, 1);
    expect(px(area.style.width)).toBeCloseTo(150 * MM, 1);
    expect(px(area.style.height)).toBeCloseTo(257 * MM, 1);
  });

  it("centres fit-page and top-left aligns fit-width", () => {
    setup({ fitMode: "fit-page" });
    let frame = screen.getByTitle("Print preview");
    expect(px(frame.style.top)).toBeGreaterThan(0);
    expect(px(frame.style.left)).toBeCloseTo(0, 3);
    document.body.innerHTML = "";
    setup({ fitMode: "fit-width" });
    frame = screen.getByTitle("Print preview");
    expect(px(frame.style.top)).toBeCloseTo(0, 3);
  });

  it("follows the paper: landscape paper with the design unchanged", () => {
    setup({ paperW: 297, paperH: 210 });
    const sheet = screen.getByTestId("print-sheet");
    expect(px(sheet.style.width)).toBeCloseTo(297 * MM, 1);
    const frame = screen.getByTitle("Print preview");
    expect(px(frame.style.width)).toBeCloseTo(102 * MM, 1);
    // content 287 x 200 → height is the tighter axis
    expect(frame.style.transform).toBe(`scale(${200 / 102})`);
  });

  it("shows one sheet per record", () => {
    setup({ pages: ["<p>a</p>", "<p>b</p>", "<p>c</p>"] });
    expect(screen.getAllByTestId("print-sheet")).toHaveLength(3);
    expect(screen.getByTitle("Print preview 2")).toBeTruthy();
  });

  it("continues a tall design on the next sheet in fit-width", () => {
    setup({ designW: 80, designH: 400, fitMode: "fit-width" });
    const frames = screen.getAllByTitle(/Print preview/);
    expect(frames.length).toBe(4); // 400 * 2.5 = 1000 mm over 287 mm sheets
    expect(px(frames[1].style.top)).toBeCloseTo(-287 * MM, 1);
  });

  it("applies grayscale to the sheet only when asked", () => {
    setup({ grayscale: true });
    const paper = screen.getByTestId("print-sheet")
      .firstElementChild as HTMLElement;
    expect(paper.style.filter).toBe("grayscale(1)");
  });

  it("sandboxes the design frame", () => {
    setup();
    expect(screen.getByTitle("Print preview").getAttribute("sandbox")).toBe("");
  });
});
