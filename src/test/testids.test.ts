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
		for (const id of Object.values(testids)) {
			expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
		}
	});

	it("uses every registered id in src/, exactly once", () => {
		for (const id of Object.values(testids)) {
			const needle = `data-testid="${id}"`;
			const hits = sources.filter(({ text }) => text.includes(needle));
			expect(
				hits.map(({ path }) => path),
				`test id "${id}" must appear exactly once in src/`,
			).toHaveLength(1);
		}
	});
});
