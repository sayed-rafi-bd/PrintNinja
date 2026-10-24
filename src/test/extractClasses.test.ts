import { describe, it, expect } from "vitest";
import { t } from "i18next";
import "@/lib/i18n";
import { extractClasses } from "@/lib/templates/extractClasses";
import { STARTER_TEMPLATES } from "@/lib/templates/defaultTemplate";

describe("extractClasses: literals", () => {
  it("collects plain classes, unique and sorted", () => {
    const { candidates, warnings } = extractClasses(
      `<div class="p-4 flex"><span class="flex text-sm">x</span></div>`,
    );
    expect(candidates).toEqual(["flex", "p-4", "text-sm"]);
    expect(warnings).toEqual([]);
  });

  it("keeps arbitrary values", () => {
    const { candidates } = extractClasses(
      `<p class="w-[37mm] text-[10px] bg-[var(--c)]">x</p>`,
    );
    expect(candidates).toEqual(["bg-[var(--c)]", "text-[10px]", "w-[37mm]"]);
  });

  it("keeps variants and fractions", () => {
    const { candidates } = extractClasses(
      `<p class="print:hidden w-1/2 md:flex">x</p>`,
    );
    expect(candidates).toEqual(["md:flex", "print:hidden", "w-1/2"]);
  });

  it("reads single-quoted and multi-line attributes", () => {
    const { candidates } = extractClasses(
      `<p class='a-1\n   b-2'>x</p>\n<p class = "c-3">y</p>`,
    );
    expect(candidates).toEqual(["a-1", "b-2", "c-3"]);
  });

  it("ignores look-alike attributes", () => {
    const { candidates } = extractClasses(
      `<p data-class="nope" className="nope2" style="x">y</p>`,
    );
    expect(candidates).toEqual([]);
  });

  it("returns nothing for markup without classes", () => {
    expect(extractClasses("<p>hello {{name}}</p>")).toEqual({
      candidates: [],
      warnings: [],
    });
  });
});

describe("extractClasses: write both literals", () => {
  it("collects the class from every branch", () => {
    const { candidates, warnings } = extractClasses(
      `<b class="p-2 {{#if urgent}}bg-red-600{{else}}bg-green-600{{/if}}">x</b>`,
    );
    expect(candidates).toEqual(["bg-green-600", "bg-red-600", "p-2"]);
    expect(warnings).toEqual([]);
  });

  it("handles else-if chains and inverted blocks", () => {
    const { candidates, warnings } = extractClasses(
      `<b class="{{#if a}}text-red-500{{else if b}}text-green-500{{else}}text-black{{/if}} {{^c}}italic{{/c}}">x</b>`,
    );
    expect(candidates).toEqual([
      "italic",
      "text-black",
      "text-green-500",
      "text-red-500",
    ]);
    expect(warnings).toEqual([]);
  });

  it("collects classes written as quoted helper arguments", () => {
    const { candidates, warnings } = extractClasses(
      `<b class="p-2 {{cls urgent "bg-red-600 text-white" 'bg-green-600'}}">x</b>`,
    );
    expect(candidates).toEqual([
      "bg-green-600",
      "bg-red-600",
      "p-2",
      "text-white",
    ]);
    expect(warnings).toEqual([]);
  });

  it("does not treat comparison values in block tags as classes", () => {
    const { candidates } = extractClasses(
      `<b class="{{#if (eq status "hidden")}}flex{{/if}}">x</b>`,
    );
    expect(candidates).toEqual(["flex"]);
  });

  it("is not confused by quotes inside mustaches", () => {
    const { candidates } = extractClasses(
      `<b class="{{lookup map "k"}} mt-2">x</b><i class="mb-2">y</i>`,
    );
    // The quote inside the mustache must not end the attribute early.
    expect(candidates).toContain("mt-2");
    expect(candidates).toContain("mb-2");
  });

  it("ignores handlebars comments", () => {
    const { candidates, warnings } = extractClasses(
      `<b class="p-2 {{!-- "bg-red-600" --}} m-2">x</b>`,
    );
    expect(candidates).toEqual(["m-2", "p-2"]);
    expect(warnings).toEqual([]);
  });

  it("allows a whole-token expression between classes", () => {
    const { candidates, warnings } = extractClasses(
      `<b class="p-2 {{cls}} m-2">x</b>`,
    );
    expect(candidates).toEqual(["m-2", "p-2"]);
    expect(warnings).toEqual([]);
  });

  it("finds classes inside each blocks and triple-stash output", () => {
    const { candidates, warnings } = extractClasses(
      `{{#each rows}}<tr class="border-b {{{raw}}}"><td class="px-2">{{this}}</td></tr>{{/each}}`,
    );
    expect(candidates).toEqual(["border-b", "px-2"]);
    expect(warnings).toEqual([]);
  });
});

describe("extractClasses: classes built from data", () => {
  it("warns about a class assembled around an expression", () => {
    const { candidates, warnings } = extractClasses(
      `<b class="p-2 bg-{{color}}-500">x</b>`,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].snippet).toBe("bg-{{color}}-500");
    // The fragments must not leak into the candidate list.
    expect(candidates).toEqual(["p-2"]);
  });

  it("warns about an expression inside an arbitrary value", () => {
    const { candidates, warnings } = extractClasses(
      `<b class="w-[{{width}}mm] flex">x</b>`,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].snippet).toBe("w-[{{width}}mm]");
    expect(candidates).toEqual(["flex"]);
  });

  it("warns about a trailing expression", () => {
    const { warnings } = extractClasses(`<b class="p-{{n}}">x</b>`);
    expect(warnings.map((w) => w.snippet)).toEqual(["p-{{n}}"]);
  });

  it("warns about a leading expression", () => {
    const { warnings } = extractClasses(`<b class="{{prefix}}flex">x</b>`);
    expect(warnings.map((w) => w.snippet)).toEqual(["{{prefix}}flex"]);
  });

  it("warns about adjacent expressions", () => {
    const { warnings } = extractClasses(`<b class="{{a}}{{b}}">x</b>`);
    expect(warnings.map((w) => w.snippet)).toEqual(["{{a}}{{b}}"]);
  });

  it("warns about a fragment completed by a block tag", () => {
    const { candidates, warnings } = extractClasses(
      `<b class="bg-{{#if x}}red-600{{/if}}">x</b>`,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].snippet).toBe("bg-{{#if x}}");
    expect(candidates).not.toContain("bg-");
  });

  it("warns inside a branch too", () => {
    const { warnings } = extractClasses(
      `<b class="{{#if x}}text-{{size}}{{/if}}">x</b>`,
    );
    expect(warnings.map((w) => w.snippet)).toEqual(["text-{{size}}"]);
  });

  it("reports one warning per expression and the right line", () => {
    const html = `<p>\n<b class="a-1">x</b>\n<b class="bg-{{c}}-500">y</b>\n</p>`;
    const { warnings } = extractClasses(html);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].line).toBe(3);
    expect(html.slice(warnings[0].index)).toMatch(/^bg-\{\{c\}\}-500/);
  });

  it("does not warn when a bare fragment has no expression next to it", () => {
    const { candidates, warnings } = extractClasses(
      `<b class="bg- flex">x</b>`,
    );
    expect(warnings).toEqual([]);
    expect(candidates).toEqual(["flex"]);
  });

  it("points at the fix in the message", () => {
    const { warnings } = extractClasses(`<b class="bg-{{c}}">x</b>`);
    expect(warnings[0].messageKey).toBe("designer.glue_message");
    expect(t(warnings[0].messageKey)).toContain("{{#if x}}bg-red-600");
    expect(t(warnings[0].messageKey)).toContain("var(--c)");
  });
});

describe("extractClasses: robustness", () => {
  it("skips an unterminated attribute without throwing", () => {
    expect(() => extractClasses(`<b class="p-2 {{oops`)).not.toThrow();
    expect(extractClasses(`<b class="p-2`).candidates).toEqual([]);
  });

  it("keeps scanning after an unterminated mustache", () => {
    const { candidates } = extractClasses(
      `<b class="{{oops">x</b><i class="m-2">y</i>`,
    );
    expect(candidates).toContain("m-2");
  });
});

describe("extractClasses: bundled starter templates", () => {
  it.each(STARTER_TEMPLATES.map((t) => [t.name, t.html] as const))(
    "%s has classes and no warnings",
    (_name, html) => {
      const { candidates, warnings } = extractClasses(html);
      expect(candidates.length).toBeGreaterThan(5);
      expect(candidates).toContain("text-[10px]");
      expect(warnings).toEqual([]);
    },
  );
});
