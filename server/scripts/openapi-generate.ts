import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";

// Writes the generated OpenAPI document to server/openapi/openapi.json
// (committed; CI fails when it drifts — REFACTORING.md section 10).
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "openapi", "openapi.json");

const app = await buildApp({ logger: false });
await app.ready();
const document = JSON.stringify(app.swagger(), null, 2);
await app.close();

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${document}\n`);
console.log(`wrote ${out}`);
