import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The one place a version string comes from, so /v2/health, the OpenAPI
// document and the package cannot drift apart.
//
// A fixed relative path cannot survive compilation: src/version.ts is
// two levels below server/package.json, but the emitted dist/version.js
// sits wherever outDir puts it. So the version is found by walking up
// from this file to the first package.json that carries one.
function findPackageVersion(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 5; i += 1) {
		const candidate = join(dir, "package.json");
		if (existsSync(candidate)) {
			const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
				version?: unknown;
			};
			if (typeof parsed.version === "string" && parsed.version.length > 0) {
				return parsed.version;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	throw new Error("version.ts: no package.json with a version found above");
}

export const APP_VERSION = findPackageVersion();
