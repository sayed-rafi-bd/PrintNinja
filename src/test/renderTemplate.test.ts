import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderTemplate, wrapWithTailwind } from "@/lib/render/renderTemplate";
import {
  TEMPLATE_BASE_CSS,
  TEMPLATE_PRINT_CSS,
  buildTemplateCss,
  injectStyles,
} from "@/lib/templates/templateCss";
import {
  DEFAULT_MOCK_DATA,
  STARTER_TEMPLATES,
} from "@/lib/templates/defaultTemplate";

const ROOT = resolve(__dirname, "../..");

describe("bundled print stylesheet", () => {
  it("exists as a committed build artifact", () => {
    // Regenerate with: pnpm build:templates:css
    expect(TEMPLATE_PRINT_CSS.length).toBeGreaterThan(5000);
  });

  it("never references the Tailwind CDN", () => {
    // Regression for #35/#81: templates used to load cdn.tailwindcss.com.
    expect(TEMPLATE_PRINT_CSS).not.toContain("cdn.tailwindcss.com");
    expect(TEMPLATE_BASE_CSS).not.toContain("cdn.tailwindcss.com");
    expect(buildTemplateCss()).not.toContain("cdn.");
  });

  it("contains no external resource references", () => {
    expect(TEMPLATE_PRINT_CSS).not.toMatch(/url\(\s*['"]?https?:/i);
    expect(TEMPLATE_PRINT_CSS).not.toContain("@import");
  });

  it("stays small enough to inline into every print job", () => {
    // A full safelist across all Tailwind variants produced ~430 KB.
    expect(TEMPLATE_PRINT_CSS.length).toBeLessThan(120_000);
  });

  it("carries Tailwind's preflight reset and print essentials", () => {
    expect(TEMPLATE_PRINT_CSS).toContain("box-sizing:border-box");
    expect(TEMPLATE_PRINT_CSS).toContain("print-color-adjust");
  });

  it("emits a rule for every utility in the Tailwind safelist", () => {
    const config = readFileSync(
      resolve(ROOT, "tailwind.templates.config.ts"),
      "utf8",
    );
    const paletteMatch = config.match(
      /const PALETTE = \[([\s\S]*?)\n\];/,
    );
    expect(paletteMatch, "PALETTE must still exist in the config").toBeTruthy();

    const utilities = [
      ...(paletteMatch![1].match(/"([^"]+)"/g) ?? []),
    ].map((u) => u.replace(/"/g, "").replace("\\/", "/"));

    expect(utilities.length).toBeGreaterThan(150);

    const missing = utilities.filter(
      (u) => !TEMPLATE_PRINT_CSS.includes(`.${CSS_ESCAPE(u)}`),
    );
    expect(missing, "run `pnpm build:templates:css`").toEqual([]);
  });

  it("emits a rule for every class used by the starter templates", () => {
    const source = readFileSync(
      resolve(ROOT, "src/lib/templates/defaultTemplate.ts"),
      "utf8",
    );
    const classAttrs = [
      ...source.matchAll(/class="([^"]+)"/g),
    ].flatMap((m) => m[1].split(/\s+/).filter(Boolean));

    // Arbitrary values like text-[10px] are not safelisted; they are picked
    // up by the config's `content` glob instead.
    const plain = classAttrs.filter((c) => !c.includes("["));
    expect(plain.length).toBeGreaterThan(20);

    const missing = plain.filter(
      (c) => !TEMPLATE_PRINT_CSS.includes(`.${CSS_ESCAPE(c)}`),
    );
    expect(missing, "run `pnpm build:templates:css`").toEqual([]);
  });
});

/** Escape the characters Tailwind escapes in class selectors. */
function CSS_ESCAPE(name: string): string {
  return name.replace(/([/:.%])/g, "\\$1");
}

describe("buildTemplateCss", () => {
  it("puts the base print rules before the Tailwind bundle", () => {
    const css = buildTemplateCss();
    expect(css.indexOf("@page")).toBeLessThan(css.indexOf("--tw-"));
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
    expect(injectStyles("<p>x</p>", "a{}")).toContain("<style data-printninja>");
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
    expect(renderTemplate('{{currency p "€"}}', "", { p: 3 })).toContain("€3.00");
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
    const out = renderTemplate(
      "{{#each items}}{{name}};{{/each}}",
      "",
      { items: [{ name: "a" }, { name: "b" }] },
    );
    expect(out).toContain("a;");
    expect(out).toContain("b;");
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

  it("receipt resolves the mock order data", () => {
    const receipt = STARTER_TEMPLATES[0];
    const out = renderTemplate(
      receipt.html,
      receipt.css,
      DEFAULT_MOCK_DATA as any,
    );
    expect(out).toContain(DEFAULT_MOCK_DATA.store.name);
    expect(out).toContain(DEFAULT_MOCK_DATA.order.id);
    expect(out).not.toContain("{{");
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

  it("replaces the shared bundle when compiled CSS is given", () => {
    const doc = renderTemplate("<p class='w-[37mm]'>x</p>", "", {}, COMPILED);
    expect(doc).toContain(COMPILED);
    // The bundle is a fallback, not an addition.
    expect(doc).not.toContain(TEMPLATE_PRINT_CSS.slice(0, 200));
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
    "falls back to the shared bundle for %j",
    (blank) => {
      const doc = renderTemplate("<p>x</p>", "", {}, blank as string | null | undefined);
      expect(doc).toContain(TEMPLATE_PRINT_CSS.slice(0, 200));
    },
  );
});
