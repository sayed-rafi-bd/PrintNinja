import { describe, it, expect } from "vitest";
import {
  validateBarcode,
  generateBarcodeSvg,
  buildBarcodeHtml,
  mmToPx,
  snapModuleToDot,
  BARCODE_TYPES,
  bcidFor,
  labelFor,
  buildBarcodeSnippet,
  isHelperSymbology,
  PRINT_SYMBOLOGIES,
} from "@/lib/utils/barcode";

describe("generateBarcodeSvg", () => {
  it("returns a real SVG element, not a data URI", () => {
    const svg = generateBarcodeSvg({ type: "code128", value: "ABC123" });
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    // The old bug produced a canvas data URI labelled as SVG.
    expect(svg).not.toContain("data:image/svg+xml");
    expect(svg).not.toContain("base64,");
  });

  it("renders every supported symbology without throwing", () => {
    const values: Record<string, string> = {
      code128: "ABC123",
      code39: "ABC-123",
      code93: "TEST93",
      ean13: "4006381333931",
      ean8: "96385074",
      upca: "03600029145",
      upce: "01234565",
      itf: "1234",
      itf14: "12345678901231",
      codabar: "A12345B",
      qr: "https://example.com",
      datamatrix: "PrintNinja",
      pdf417: "PN-1042",
      aztec: "PN-1042",
    };

    for (const { value: type, bcid } of BARCODE_TYPES) {
      const svg = generateBarcodeSvg({ type, value: values[type] });
      expect(svg, `${type} (bcid=${bcid}) should render`).toContain("<svg");
    }
  });

  it("returns an empty string for an unsupported symbology", () => {
    expect(generateBarcodeSvg({ type: "nope", value: "x" })).toBe("");
  });

  it("omits the human-readable text when text=false", () => {
    const withText = generateBarcodeSvg({ type: "code128", value: "ABC" });
    const withoutText = generateBarcodeSvg({
      type: "code128",
      value: "ABC",
      text: false,
    });
    expect(withoutText).not.toBe(withText);
  });
});

describe("barcode geometry", () => {
  // Regression: `width: 2` made bwip-js squeeze the whole symbol into 2 mm, so
  // a long Code 128 came out as a tall, narrow, solid black block.
  const viewBox = (svg: string) =>
    svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!.slice(1).map(Number);

  it("draws a long Code 128 wider than it is tall", () => {
    const svg = generateBarcodeSvg({ type: "code128", value: "PN-7X9K-4242-BD", text: false });
    const [w, h] = viewBox(svg);
    expect(w).toBeGreaterThan(h * 3);
  });

  it("keeps the bars apart instead of overlapping them", () => {
    const svg = generateBarcodeSvg({ type: "code128", value: "PN-7X9K-4242-BD", text: false });
    const strokeWidth = Number(svg.match(/stroke-width="([\d.]+)"/)![1]);
    const xs = [...svg.matchAll(/M([\d.]+) [\d.]+L/g)].map((m) => Number(m[1]));
    const gaps = xs.slice(1).map((x, i) => x - xs[i]).filter((g) => g > 0);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(strokeWidth);
  });

  it("a longer value makes a wider symbol", () => {
    const short = viewBox(generateBarcodeSvg({ type: "code128", value: "AB", text: false }))[0];
    const long = viewBox(generateBarcodeSvg({ type: "code128", value: "ABCDEFGHIJKL", text: false }))[0];
    expect(long).toBeGreaterThan(short);
  });

  it("draws a QR code as a square", () => {
    const [w, h] = viewBox(generateBarcodeSvg({ type: "qr", value: "https://example.com/o/1", text: false }));
    expect(w).toBe(h);
  });
});

describe("buildBarcodeHtml", () => {
  it("embeds inline SVG with an explicit mm width", () => {
    const html = buildBarcodeHtml({
      type: "qr",
      value: "https://example.com",
      scaleToWidth: 40,
    });
    expect(html).toContain("<svg");
    expect(html).toContain('width="40mm"');
    // No external reference: printable HTML must be self-contained.
    // (the SVG namespace URL is not a fetched resource)
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/src\s*=/);
    expect(html).not.toContain("data:");
    expect(html).not.toMatch(/url\(\s*http/);
  });
});

describe("validateBarcode", () => {
  it("rejects empty values for every type", () => {
    for (const { value: type } of BARCODE_TYPES) {
      expect(validateBarcode(type, ""), type).toBe("Value is required");
    }
  });

  it("accepts a valid EAN-13 with a correct check digit", () => {
    expect(validateBarcode("ean13", "4006381333931")).toBeNull();
  });

  it("rejects an EAN-13 with a wrong check digit", () => {
    expect(validateBarcode("ean13", "4006381333932")).toContain(
      "check digit",
    );
  });

  it("enforces exact digit counts for EAN/UPC", () => {
    expect(validateBarcode("ean13", "123")).toContain("13 digits");
    expect(validateBarcode("ean8", "123")).toContain("8 digits");
    expect(validateBarcode("upca", "123")).toContain("12 digits");
  });

  it("enforces Code 39's restricted charset", () => {
    expect(validateBarcode("code39", "ABC-123")).toBeNull();
    expect(validateBarcode("code39", "hello@world")).toContain(
      "only supports",
    );
  });

  it("requires ITF values to have an even number of digits", () => {
    expect(validateBarcode("itf", "1234")).toBeNull();
    expect(validateBarcode("itf", "123")).toContain("even number");
    expect(validateBarcode("itf", "12a4")).toContain("even number");
  });

  it("requires Codabar start/stop letters", () => {
    expect(validateBarcode("codabar", "A12345B")).toBeNull();
    expect(validateBarcode("codabar", "A12345")).toBeNull();
    expect(validateBarcode("codabar", "12345B")).toBeNull();
    // Neither start nor stop letter is invalid.
    expect(validateBarcode("codabar", "12345")).toContain("start/stop");
  });

  it("rejects Codabar values outside the symbol set", () => {
    expect(validateBarcode("codabar", "12#45")).toContain("start/stop");
  });

  it("accepts arbitrary text for 2D symbologies", () => {
    for (const t of ["qr", "datamatrix", "pdf417", "aztec"]) {
      expect(validateBarcode(t, "anything goes"), t).toBeNull();
    }
  });

  it("trims surrounding whitespace before validating", () => {
    expect(validateBarcode("ean13", "  4006381333931  ")).toBeNull();
  });
});

describe("dimension helpers", () => {
  it("converts mm to px at 96 dpi", () => {
    expect(mmToPx(25.4)).toBe(96);
    expect(mmToPx(12.7)).toBe(48);
  });

  it("converts mm to dots at the printer dpi", () => {
    expect(mmToPx(1, 203)).toBe(8);
    expect(mmToPx(0.25, 203)).toBe(2);
  });

  it("snaps module widths to whole dots, minimum 1", () => {
    // A fractional module width smears bars on thermal heads.
    expect(snapModuleToDot(0.24, 203) % 1).toBe(0);
    expect(snapModuleToDot(0.001, 203)).toBe(1);
    expect(Number.isInteger(snapModuleToDot(0.3, 300))).toBe(true);
  });

  it("returns whole numbers for every dot width", () => {
    for (const dpi of [203, 300, 600]) {
      expect(Number.isInteger(snapModuleToDot(0.29, dpi))).toBe(true);
    }
  });
});
describe("bwip-js encoder name mapping", () => {
  it("maps friendly ids to real bwip-js encoder names", () => {
    // These three ids do NOT match bwip-js names and threw on insert.
    expect(bcidFor("itf")).toBe("interleaved2of5");
    expect(bcidFor("codabar")).toBe("rationalizedCodabar");
    expect(bcidFor("aztec")).toBe("azteccode");
  });

  it("passes through ids that already match", () => {
    expect(bcidFor("code128")).toBe("code128");
    expect(bcidFor("ean13")).toBe("ean13");
    expect(bcidFor("qr")).toBe("qrcode");
    expect(bcidFor("datamatrix")).toBe("datamatrix");
    expect(bcidFor("pdf417")).toBe("pdf417");
  });

  it("returns null for an unknown id", () => {
    expect(bcidFor("nope")).toBeNull();
    expect(generateBarcodeSvg({ type: "nope", value: "x" })).toBe("");
  });

  it("exposes a label for every id", () => {
    for (const { value } of BARCODE_TYPES) {
      expect(labelFor(value)).toBeTruthy();
      expect(labelFor(value)).not.toBe(value);
    }
  });
});

describe("buildBarcodeSnippet", () => {
  it("inserts a helper call that reads a data field", () => {
    expect(buildBarcodeSnippet("code128", "order.id", true)).toEqual({
      ok: true,
      kind: "helper",
      text: '{{barcode "code128" order.id}}',
    });
    expect(buildBarcodeSnippet("qr", " order.url ", true)).toEqual({
      ok: true,
      kind: "helper",
      text: "{{qrcode order.url}}",
    });
  });

  it("rejects something that is not a field path", () => {
    for (const bad of ["order id", "{{order.id}}", "order.", "1abc", 'a"b']) {
      const r = buildBarcodeSnippet("code128", bad, true);
      expect(r.ok, bad).toBe(false);
    }
  });

  it("refuses a data field for symbologies the print path cannot draw", () => {
    const r = buildBarcodeSnippet("datamatrix", "order.id", true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Data Matrix");
  });

  it("quotes a fixed value and still uses the helper", () => {
    expect(buildBarcodeSnippet("code128", "ABC-123", false)).toEqual({
      ok: true,
      kind: "helper",
      text: '{{barcode "code128" "ABC-123"}}',
    });
    expect(buildBarcodeSnippet("qr", "https://example.com", false)).toEqual({
      ok: true,
      kind: "helper",
      text: '{{qrcode "https://example.com"}}',
    });
  });

  it("validates a fixed value for its symbology", () => {
    const r = buildBarcodeSnippet("ean13", "123", false);
    expect(r).toEqual({ ok: false, error: "EAN-13 requires exactly 13 digits" });
  });

  it("uses single quotes when the value holds a double quote, and rejects both", () => {
    expect(buildBarcodeSnippet("code128", 'a"b', false)).toMatchObject({
      ok: true,
      text: `{{barcode "code128" 'a"b'}}`,
    });
    expect(buildBarcodeSnippet("code128", `a"b'c`, false).ok).toBe(false);
  });

  it("keeps preview-only symbologies as a static SVG", () => {
    const r = buildBarcodeSnippet("datamatrix", "PN-1042", false);
    expect(r).toMatchObject({ ok: true, kind: "static" });
    if (r.ok) expect(r.text).toContain("<svg");
  });

  it("requires a value", () => {
    expect(buildBarcodeSnippet("code128", "  ", true)).toEqual({
      ok: false,
      error: "Value is required",
    });
  });
});

describe("print symbologies", () => {
  it("are all known to the Designer picker", () => {
    for (const t of PRINT_SYMBOLOGIES) {
      expect(BARCODE_TYPES.some((b) => b.value === t), t).toBe(true);
    }
  });

  it("treat QR as a helper type too", () => {
    expect(isHelperSymbology("qr")).toBe(true);
    expect(isHelperSymbology("datamatrix")).toBe(false);
  });
});
