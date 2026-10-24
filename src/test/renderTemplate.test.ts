import { describe, it, expect } from "vitest";
import {
  buildLayoutCss,
  fitZoom,
  renderRecords,
  renderTemplate,
  resolvePaper,
  wrapWithTailwind,
  type PreviewLayout,
} from "@/lib/render/renderTemplate";
import {
  TEMPLATE_BASE_CSS,
  buildTemplateCss,
  injectStyles,
} from "@/lib/templates/templateCss";
import {
  DEFAULT_MOCK_DATA,
  STARTER_TEMPLATES,
} from "@/lib/templates/defaultTemplate";

describe("base print stylesheet", () => {
  it("never references the Tailwind CDN", () => {
    // Regression for #35/#81: templates used to load cdn.tailwindcss.com.
    expect(TEMPLATE_BASE_CSS).not.toContain("cdn.tailwindcss.com");
    expect(buildTemplateCss()).not.toContain("cdn.");
  });

  it("contains no external resource references", () => {
    expect(TEMPLATE_BASE_CSS).not.toMatch(/url\(\s*['"]?https?:/i);
    expect(TEMPLATE_BASE_CSS).not.toContain("@import");
  });

  it("carries the reset and print essentials", () => {
    expect(TEMPLATE_BASE_CSS).toContain("box-sizing:border-box");
    expect(TEMPLATE_BASE_CSS).toContain("print-color-adjust");
  });

  it("defines the Designer's helper classes", () => {
    for (const c of [
      ".page-break-before",
      ".page-break-after",
      ".page-break-inside-avoid",
      ".no-print",
      ".print-only",
      ".barcode",
    ]) {
      expect(TEMPLATE_BASE_CSS, c).toContain(c);
    }
  });

  it("is small: the Tailwind rules come from the template, not from here", () => {
    expect(TEMPLATE_BASE_CSS.length).toBeLessThan(2_000);
  });
});

describe("buildTemplateCss", () => {
  it("puts the base print rules before the template's Tailwind CSS", () => {
    const css = buildTemplateCss("", ".flex{display:flex}");
    expect(css.indexOf("@page")).toBeLessThan(
      css.indexOf(".flex{display:flex}"),
    );
  });

  it("is just the base rules for a template with no compiled CSS", () => {
    expect(buildTemplateCss()).toBe(TEMPLATE_BASE_CSS);
  });

  it("appends caller CSS last so it wins", () => {
    const css = buildTemplateCss(".brand{color:red}");
    expect(css.endsWith(".brand{color:red}")).toBe(true);
  });

  it("ignores empty caller CSS", () => {
    expect(buildTemplateCss("")).toBe(buildTemplateCss());
    expect(buildTemplateCss(null)).toBe(buildTemplateCss());
    expect(buildTemplateCss("   ")).toBe(buildTemplateCss());
  });
});

describe("injectStyles", () => {
  it("injects before </head>", () => {
    const out = injectStyles("<html><head></head><body>x</body></html>", "a{}");
    expect(out.indexOf("<style")).toBeLessThan(out.indexOf("</head>"));
  });

  it("injects before <body> when there is no head", () => {
    const out = injectStyles("<body>x</body>", "a{}");
    expect(out.indexOf("<style")).toBeLessThan(out.indexOf("<body"));
  });

  it("injects after <html> but before </html> when there is no head/body", () => {
    const out = injectStyles("<html><p>x</p></html>", "a{}");
    expect(out.indexOf("<html>")).toBeLessThan(out.indexOf("<style"));
    expect(out.indexOf("<style")).toBeLessThan(out.indexOf("</html>"));
  });

  it("handles a bare fragment", () => {
    expect(injectStyles("<p>x</p>", "a{}")).toContain(
      "<style data-printninja>",
    );
  });

  it("marks the tag so callers can find and replace it", () => {
    expect(injectStyles("<p>x</p>", "a{}")).toContain("data-printninja");
  });
});

describe("renderTemplate", () => {
  it("renders a simple template with data", () => {
    const result = renderTemplate("<p>{{name}}</p>", "", { name: "Test" });
    expect(result).toContain("Test");
  });

  it("inlines the print stylesheet instead of a CDN link", () => {
    // Offline printing + strict CSP: no external stylesheet may be used.
    const result = renderTemplate("<p>x</p>", "", {});
    expect(result).toContain("<style data-printninja>");
    expect(result).not.toContain("cdn.tailwindcss.com");
    expect(result).not.toMatch(/<link[^>]+stylesheet/i);
    expect(result).not.toMatch(/<script/i);
  });

  it("keeps caller CSS alongside the base stylesheet", () => {
    const result = renderTemplate("<p>x</p>", ".brand{color:red}", {});
    expect(result).toContain(".brand{color:red}");
    expect(result).toContain("@page");
  });

  it("wraps a fragment in a full document", () => {
    const result = renderTemplate("<p>x</p>", "", {});
    expect(result).toContain("<!DOCTYPE html>");
    expect(result).toContain("</html>");
  });

  it("injects into an existing full document instead of nesting one", () => {
    const full =
      "<!DOCTYPE html><html><head><title>t</title></head><body><p>{{name}}</p></body></html>";
    const result = renderTemplate(full, "", { name: "Zed" });
    expect(result.match(/<html/gi)?.length).toBe(1);
    expect(result).toContain("Zed");
  });

  it("keeps helpers working across repeated renders", () => {
    // Handlebars' registry is a global singleton; helpers must not be
    // re-registered (which leaks) nor lost between renders.
    const out = ["a", "b", "c"]
      .map((n) => renderTemplate("{{upper n}}", "", { n }))
      .join("|");
    expect(out).toContain("A");
    expect(out).toContain("B");
    expect(out).toContain("C");
  });

  it("renders a broken template instead of throwing", () => {
    const result = renderTemplate("{{#each unclosed}}", "", {});
    expect(result).toContain("<!DOCTYPE html>");
    expect(result).toContain("unclosed");
  });
});

describe("helpers", () => {
  it("currency defaults to $ and respects a custom symbol", () => {
    expect(renderTemplate("{{currency p}}", "", { p: 10.5 })).toContain(
      "$10.50",
    );
    expect(renderTemplate('{{currency p "€"}}', "", { p: 3 })).toContain(
      "€3.00",
    );
  });

  it("currency tolerates a missing value", () => {
    expect(renderTemplate("{{currency nope}}", "", {})).toContain("$0.00");
  });

  it("upper/lower", () => {
    expect(renderTemplate("{{upper n}}", "", { n: "ab" })).toContain("AB");
    expect(renderTemplate("{{lower n}}", "", { n: "AB" })).toContain("ab");
  });

  it("number honours a decimal count", () => {
    expect(renderTemplate("{{number v 2}}", "", { v: 3.14159 })).toContain(
      "3.14",
    );
    expect(renderTemplate("{{number v}}", "", { v: 3.7 })).toContain("4");
  });

  it("padLeft uses a custom pad character", () => {
    const out = renderTemplate('{{padLeft n 5 "0"}}', "", { n: "42" });
    expect(out).toContain("00042");
  });

  it("padLeft defaults to spaces", () => {
    expect(renderTemplate("{{padLeft n 5}}", "", { n: "42" })).toContain(
      "   42",
    );
  });

  it("date falls back to the raw value when unparseable", () => {
    const out = renderTemplate("{{date d}}", "", { d: "not-a-date" });
    expect(out).toContain("not-a-date");
    expect(out).not.toContain("%Y-%m-%d");
  });

  it("each loops", () => {
    const out = renderTemplate("{{#each items}}{{name}};{{/each}}", "", {
      items: [{ name: "a" }, { name: "b" }],
    });
    expect(out).toContain("a;");
    expect(out).toContain("b;");
  });
});

describe("barcode and qrcode helpers", () => {
  const body = (html: string, data: Record<string, unknown> = {}) =>
    renderTemplate(html, "", data);

  it("barcode reads its value from the data", () => {
    const out = body('{{barcode "code128" order.id}}', {
      order: { id: "ORD-1042" },
    });
    expect(out).toContain('<div class="barcode"');
    expect(out).toContain("<svg");
    expect(out).toContain('width="40mm"');
    // Not escaped by Handlebars.
    expect(out).not.toContain("&lt;svg");
  });

  it("barcode renders a different image for a different row", () => {
    const a = body('{{barcode "code128" id}}', { id: "AAA111" });
    const b = body('{{barcode "code128" id}}', { id: "BBB222" });
    expect(a).not.toBe(b);
  });

  it("barcode accepts a number and honours width", () => {
    const out = body('{{barcode "code128" n width=60}}', { n: 1042 });
    expect(out).toContain('width="60mm"');
  });

  it("barcode clamps the width like the Rust helper", () => {
    expect(body('{{barcode "code128" v width=9999}}', { v: "X" })).toContain(
      'width="200mm"',
    );
    expect(body('{{barcode "code128" v width=1}}', { v: "X" })).toContain(
      'width="5mm"',
    );
  });

  it("barcode prints nothing for a missing, invalid or preview-only value", () => {
    const empty = (html: string, data: Record<string, unknown> = {}) =>
      body(html, data)
        .match(/<body>([\s\S]*?)<\/body>/)?.[1]
        ?.trim();
    expect(empty('{{barcode "code128" nope}}')).toBe("");
    expect(empty('{{barcode "code128"}}')).toBe("");
    // EAN-13 needs 13 digits with a correct check digit.
    expect(empty('{{barcode "ean13" v}}', { v: "123" })).toBe("");
    expect(empty('{{barcode "ean13" v}}', { v: "5901234123458" })).toBe("");
    expect(empty('{{barcode "ean13" v}}', { v: "5901234123457" })).toContain(
      "<svg",
    );
    // Data Matrix is not implemented by the Rust renderer, so no preview either.
    expect(empty('{{barcode "datamatrix" v}}', { v: "123" })).toBe("");
  });

  it("barcode works inside {{#each}} for batch printing", () => {
    const out = body(
      '{{#each rows}}[{{barcode "code128" this.sku}}]{{/each}}',
      {
        rows: [{ sku: "A1" }, { sku: "B2" }],
      },
    );
    expect(out.match(/<svg/g)?.length).toBe(2);
  });

  it("qrcode reads its value from the data and honours size", () => {
    const out = body("{{qrcode url size=30}}", {
      url: "https://example.com/o/1",
    });
    expect(out).toContain("<svg");
    expect(out).toContain('width="30mm"');
  });

  it("qrcode prints nothing for an empty value", () => {
    const out = body("{{qrcode url}}", { url: "" });
    expect(out).not.toContain("<svg");
  });

  it("the sanitizer keeps the barcode but would still strip a script in the value", () => {
    const out = body('{{barcode "code128" v}}', {
      v: "<script>alert(1)</script>",
    });
    expect(out).not.toContain("<script");
  });
});

describe("starter templates", () => {
  it("all render against the mock data without throwing", () => {
    for (const tpl of STARTER_TEMPLATES) {
      const out = renderTemplate(tpl.html, tpl.css, DEFAULT_MOCK_DATA as any);
      expect(out, tpl.name).toContain("<!DOCTYPE html>");
      expect(out, tpl.name).toContain("<style data-printninja>");
      expect(out, tpl.name).not.toContain("cdn.tailwindcss.com");
    }
  });

  it("every starter template has sane page dimensions", () => {
    for (const tpl of STARTER_TEMPLATES) {
      expect(tpl.page_w_mm, tpl.name).toBeGreaterThan(0);
      expect(tpl.page_h_mm, tpl.name).toBeGreaterThan(0);
      expect(tpl.orientation, tpl.name).toMatch(/portrait|landscape/);
    }
  });

  it("the label resolves the mock order data", () => {
    const label = STARTER_TEMPLATES[0];
    const out = renderTemplate(label.html, label.css, DEFAULT_MOCK_DATA as any);
    expect(out).toContain(DEFAULT_MOCK_DATA.store.name);
    expect(out).toContain(DEFAULT_MOCK_DATA.order.id);
    expect(out).not.toContain("{{");
  });

  it("the label carries a Code 128 barcode of the tracking number", () => {
    const label = STARTER_TEMPLATES[0];
    expect(label.html).toContain('{{barcode "code128" order.tracking');
    const out = renderTemplate(label.html, label.css, DEFAULT_MOCK_DATA as any);
    expect(out).toContain('<div class="barcode"');
    expect(out).toContain("<svg");
    // A different tracking number gives a different barcode.
    const other = renderTemplate(label.html, label.css, {
      ...DEFAULT_MOCK_DATA,
      order: { ...DEFAULT_MOCK_DATA.order, tracking: "PN-0000-0000-XX" },
    } as any);
    expect(other).not.toBe(out);
  });
});

describe("wrapWithTailwind", () => {
  it("produces a self-contained document", () => {
    const out = wrapWithTailwind("<p>hi</p>", "");
    expect(out).toContain("<!DOCTYPE html>");
    expect(out).toContain("<style data-printninja>");
  });
});

describe("per-template compiled CSS", () => {
  const COMPILED = ".w-\\[37mm\\]{width:37mm}";

  it("is inlined into the rendered document", () => {
    const doc = renderTemplate("<p class='w-[37mm]'>x</p>", "", {}, COMPILED);
    expect(doc).toContain(COMPILED);
  });

  it("keeps the base reset first and the template's own CSS last", () => {
    const doc = renderTemplate("<p>x</p>", ".brand{color:#f00}", {}, COMPILED);
    const base = doc.indexOf("box-sizing:border-box");
    const compiled = doc.indexOf(COMPILED);
    const own = doc.indexOf(".brand{color:#f00}");
    expect(base).toBeGreaterThanOrEqual(0);
    expect(compiled).toBeGreaterThan(base);
    expect(own).toBeGreaterThan(compiled);
  });

  it.each([undefined, null, "", "  \n "])(
    "renders with the base rules only for %j",
    (blank) => {
      const doc = renderTemplate(
        "<p>x</p>",
        "",
        {},
        blank as string | null | undefined,
      );
      expect(doc).toContain("box-sizing:border-box");
      expect(doc).not.toContain("--tw-");
    },
  );
});

describe("renderRecords", () => {
  it("renders one page for a single object", () => {
    const doc = renderRecords("<p>Hi {{name}}</p>", "", { name: "Ana" });
    expect(doc).toContain("Hi Ana");
    expect(doc).not.toContain('<div style="break-before:page"></div>');
  });

  it("renders one page per array element with page breaks", () => {
    const doc = renderRecords("<p>Hi {{name}}</p>", "", [
      { name: "Ana" },
      { name: "Bo" },
    ]);
    expect(doc).toContain("Hi Ana");
    expect(doc).toContain("Hi Bo");
    expect(doc.indexOf("Hi Bo")).toBeGreaterThan(doc.indexOf("Hi Ana"));
    expect(doc).toContain('<div style="break-before:page"></div>');
    // Wrapped once, not once per record.
    expect(doc.match(/<!DOCTYPE html>/g)).toHaveLength(1);
  });
});

const layout = (over: Partial<PreviewLayout> = {}): PreviewLayout => ({
  paperW: 210,
  paperH: 297,
  designW: 210,
  designH: 297,
  margins: { top: 5, right: 5, bottom: 5, left: 5 },
  fitMode: "fit-width",
  ...over,
});

describe("resolvePaper", () => {
  it("swaps the paper for landscape, never the design", () => {
    expect(resolvePaper(80, 200, "landscape")).toEqual({
      paperW: 200,
      paperH: 80,
    });
    expect(resolvePaper(80, 200, "portrait")).toEqual({
      paperW: 80,
      paperH: 200,
    });
  });

  it("lets an explicit paper size win per axis", () => {
    expect(resolvePaper(80, 200, "portrait", 210, null)).toEqual({
      paperW: 210,
      paperH: 200,
    });
  });
});

describe("buildLayoutCss", () => {
  it("emits the paper box first, matching the backend rule order", () => {
    const css = buildLayoutCss(layout());
    expect(css).toContain("@page { size: 210mm 297mm;");
    expect(css.indexOf("@page")).toBeLessThan(css.indexOf("html,body"));
  });

  it("emits no zoom when design matches paper", () => {
    expect(buildLayoutCss(layout())).not.toContain("zoom:");
  });

  it("scales the design onto different paper like the backend", () => {
    const css = buildLayoutCss(
      layout({ designW: 80, designH: 200, fitMode: "fit-width" }),
    );
    // Same content-box ratio the Rust fit_zoom computes.
    const expected = (210 - 5 - 5) / (80 - 5 - 5);
    expect(css).toContain(`body{zoom:${expected.toFixed(4)}}`);
    expect(css).toContain("@page { size: 210mm 297mm;");
  });

  it("adds grayscale only when enabled", () => {
    expect(buildLayoutCss(layout())).not.toContain("grayscale(1)");
    expect(buildLayoutCss(layout({ grayscale: true }))).toContain(
      "html{filter:grayscale(1) !important;}",
    );
  });

  it("renderRecords applies the layout to the preview document", () => {
    const doc = renderRecords(
      "<p>Hi</p>",
      "",
      {},
      null,
      layout({ designW: 80, designH: 200 }),
    );
    expect(doc).toContain("@page { size: 210mm 297mm;");
    expect(doc).toContain("body{zoom:");
  });
});

describe("fitZoom", () => {
  const m = { top: 5, right: 5, bottom: 5, left: 5 };
  it("is 1 when design matches paper", () => {
    expect(fitZoom("fit-width", 80, 200, 80, 200, m)).toBe(1);
  });
  it("caps at 1 for shrink on larger paper", () => {
    expect(fitZoom("shrink", 80, 200, 210, 297, m)).toBe(1);
  });
  it("uses the limiting axis for fit-page", () => {
    expect(fitZoom("fit-page", 80, 200, 210, 297, m)).toBeCloseTo(
      Math.min((210 - 10) / (80 - 10), (297 - 10) / (200 - 10)),
      10,
    );
  });
});
