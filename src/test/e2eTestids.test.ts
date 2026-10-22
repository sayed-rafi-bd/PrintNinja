import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The testid registry (e2e/support/testids.ts) is the only source of
// data-testid literals in specs: hardcoded ids drift from the app and
// from renames. This fails on any literal getByTestId("...") or
// [data-testid="..."] in e2e/tests — add the id (or a parameterized
// helper) to the registry instead. History/Print/Printer specs use
// accessible roles and labels by design, not test ids.
describe("e2e testid registry", () => {
  it("has no hardcoded data-testid literals in specs", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const testsDir = resolve(here, "..", "..", "e2e", "tests");
    const bad: string[] = [];
    for (const entry of readdirSync(testsDir)) {
      if (!entry.endsWith(".e2e.ts")) continue;
      const text = readFileSync(join(testsDir, entry), "utf8");
      for (const match of text.matchAll(
        /getByTestId\(\s*"([^"]+)"\s*\)|\[data-testid=(?:"([^"]+)"|'\${[^}]+}'\s*\])/g,
      )) {
        // Template form [data-testid="${testids.x}"] is the registry.
        const literal = match[1] ?? match[2];
        if (literal && !literal.includes("${")) {
          bad.push(`${entry}: ${literal}`);
        }
      }
    }
    expect(bad, "hardcoded test ids (use testids.*)").toEqual([]);
  });
});
