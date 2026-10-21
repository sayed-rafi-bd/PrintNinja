import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { testids } from "../../e2e/support/testids.js";

// One registry (REFACTORING.md D24): every data-testid in the app comes
// from e2e/support/testids.ts, and static ids appear exactly once in
// src/. Dynamic ids (server UUIDs spliced into a registry function)
// arrive with the screens that need them.
function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...srcFiles(path));
    } else if (/\.(tsx?|css)$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "..");
const sources = srcFiles(srcDir).map((path) => ({
  path,
  text: readFileSync(path, "utf8"),
}));

describe("test id registry", () => {
  it("holds kebab-case ids only", () => {
    for (const [key, id] of Object.entries(testids)) {
      if (typeof id === "function") {
        // Dynamic ids are called with no input here; the shape
        // (prefix + value) is what must stay kebab-case.
        const sample = (id as (...args: never[]) => string)();
        expect(sample).toMatch(/^[a-z0-9-]+$/);
      } else if (key.endsWith("Prefix")) {
        // Prefix entries feed [data-testid^="..."] selectors; they are
        // the kebab stem plus its trailing dash.
        expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*-$/);
      } else {
        expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      }
    }
  });

  it("uses every registered id in src/, exactly once", () => {
    for (const [key, id] of Object.entries(testids)) {
      if (typeof id === "function") {
        // Dynamic ids arrive with the screens that need them: the
        // literal prefix must appear in a data-testid template.
        const prefix = (id as (...args: never[]) => string)().split(
          "undefined",
        )[0];
        const hits = sources.filter(({ text }) => text.includes(prefix));
        expect(
          hits.map(({ path }) => path),
          `dynamic test id prefix "${prefix}" must appear in src/`,
        ).not.toHaveLength(0);
        continue;
      }
      if (key.endsWith("Prefix")) {
        const hits = sources.filter(({ text }) => text.includes(id));
        expect(
          hits.map(({ path }) => path),
          `test id prefix "${id}" must appear in src/`,
        ).not.toHaveLength(0);
        continue;
      }
      const needle = `data-testid="${id}"`;
      const hits = sources.filter(({ text }) => text.includes(needle));
      expect(
        hits.map(({ path }) => path),
        `test id "${id}" must appear exactly once in src/`,
      ).toHaveLength(1);
    }
  });
});
