import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Pages and shared components take colour from semantic tokens only, so a
// state looks the same everywhere. Print templates are separate and excluded.
const RAW = /\b(?:bg|text|border|ring|fill|stroke|from|to|via)-(?:slate|gray|zinc|neutral-\d|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;
const ROOTS = ["../pages", "../components"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(p) ? [p] : [];
  });
}

describe("semantic colour tokens", () => {
  it("pages and components use no raw palette classes", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(path.resolve(__dirname, root))) {
        readFileSync(f, "utf8").split("\n").forEach((line, i) => {
          if (RAW.test(line)) offenders.push(`${path.relative(process.cwd(), f)}:${i + 1}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
