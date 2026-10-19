import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  COMPILER_REV,
  classSetKey,
  compileTemplateCss,
  flattenLayers,
  templateCssKey,
} from "@/lib/templates/compileTemplateCss";

const esc = (cls: string) => cls.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
const has = (css: string, cls: string) => css.includes(`.${esc(cls)}`);

describe("flattenLayers", () => {
  it("drops order statements and unwraps blocks", () => {
    expect(
      flattenLayers("@layer a, b;@layer a{.x{color:red}}@layer b{.y{color:blue}}"),
    ).toBe(".x{color:red}.y{color:blue}");
  });

  it("keeps rules outside layers and nested layers", () => {
    expect(flattenLayers(".k{a:b}@layer o{@layer i{.z{c:d}}}.t{e:f}")).toBe(
      ".k{a:b}.z{c:d}.t{e:f}",
    );
  });

  it("is not fooled by braces inside strings", () => {
    expect(flattenLayers('@layer a{.x::after{content:"}{"}}.y{a:b}')).toBe(
      '.x::after{content:"}{"}.y{a:b}',
    );
  });

  it("leaves css without layers untouched", () => {
    expect(flattenLayers(".a{b:c}")).toBe(".a{b:c}");
  });
});

describe("compileTemplateCss", () => {
  it("compiles classes the shared bundle never had", async () => {
    const { css, key } = await compileTemplateCss(
      `<div class="w-[37mm] bg-rose-500 grid grid-cols-5">x</div>`,
    );
    expect(key).toMatch(new RegExp(`^${COMPILER_REV}:`));
    expect(has(css, "w-[37mm]")).toBe(true);
    expect(css).toContain("37mm");
    expect(has(css, "bg-rose-500")).toBe(true);
    expect(has(css, "grid-cols-5")).toBe(true);
  });

  it("compiles both branches of a conditional", async () => {
    const { css } = await compileTemplateCss(
      `<b class="{{#if urgent}}bg-red-600{{else}}bg-green-600{{/if}}">x</b>`,
    );
    expect(has(css, "bg-red-600")).toBe(true);
    expect(has(css, "bg-green-600")).toBe(true);
  });

  it("does not compile classes built from data", async () => {
    const { css } = await compileTemplateCss(
      `<b class="bg-{{color}}-500 p-2">x</b>`,
    );
    expect(has(css, "p-2")).toBe(true);
    expect(css).not.toMatch(/\.bg-\\?\{/);
  });

  it("does not leak classes from one template into the next", async () => {
    const a = await compileTemplateCss(`<i class="p-7">a</i>`);
    const b = await compileTemplateCss(`<i class="m-9">b</i>`);
    expect(has(a.css, "p-7")).toBe(true);
    expect(has(b.css, "m-9")).toBe(true);
    expect(has(b.css, "p-7")).toBe(false);
  });

  it("emits a self-contained, network-free, layer-free stylesheet", async () => {
    const { css } = await compileTemplateCss(`<p class="flex p-4">x</p>`);
    expect(css).not.toContain("@layer");
    expect(css).not.toContain("/*");
    expect(css).not.toMatch(/https?:/i);
    expect(css).not.toContain("@import");
    // The reset is included, so unclassed markup is normalised.
    expect(css).toContain("box-sizing");
  });

  it("makes dark: follow a .dark ancestor, not the OS", async () => {
    const { css } = await compileTemplateCss(`<p class="dark:bg-black">x</p>`);
    expect(has(css, "dark:bg-black")).toBe(true);
    expect(css).toContain(".dark");
    expect(css).not.toContain("prefers-color-scheme");
  });

  it("keeps the print font stack and the v3 default border colour", async () => {
    const { css } = await compileTemplateCss(`<p class="border font-sans">x</p>`);
    expect(css).toContain("Segoe UI");
    expect(css).toMatch(/border-color:\s*var\(--color-gray-200/);
    expect(css).toMatch(/--color-gray-200:/);
  });

  it("returns the same css for the same classes", async () => {
    const one = await compileTemplateCss(`<p class="p-1 m-1">x</p>`);
    const two = await compileTemplateCss(`<p class="m-1   p-1">y</p>`);
    expect(two).toEqual(one);
  });
});

describe("class set keys", () => {
  it("ignores order, whitespace and text, but not the classes", () => {
    const a = templateCssKey(`<p class="p-1 m-1">x</p>`);
    expect(templateCssKey(`<p class="m-1 p-1">other text</p>`)).toBe(a);
    expect(templateCssKey(`<p class="m-1 p-2">x</p>`)).not.toBe(a);
  });

  it("includes the compiler revision", () => {
    expect(classSetKey(["a"]).startsWith(`${COMPILER_REV}:`)).toBe(true);
  });
});

describe("compatibility with the v3 palette", () => {
  it("emits a rule for every class the Designer palette offers", async () => {
    const config = readFileSync(
      resolve(__dirname, "../../tailwind.templates.config.ts"),
      "utf8",
    );
    const body = config.match(/const PALETTE = \[([\s\S]*?)\n\];/)?.[1] ?? "";
    const palette = [...body.matchAll(/"([^"]+)"/g)].map((m) =>
      m[1].replace("\\/", "/"),
    );
    expect(palette.length).toBeGreaterThan(150);

    const html = `<div class="${palette.join(" ")}"></div>`;
    const { css } = await compileTemplateCss(html);
    const missing = palette.filter((c) => !has(css, c));
    expect(missing).toEqual([]);
  });
});
