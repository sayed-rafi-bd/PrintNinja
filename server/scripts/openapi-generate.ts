import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { fakeDeps } from "../test/helpers.js";

// Writes the generated OpenAPI document to server/openapi/openapi.json
// (committed; CI fails when it drifts — REFACTORING.md section 10).
// Needs the same environment as the service itself (DATABASE_URL and
// CORS_ORIGINS at minimum); in development run with --env-file. Deps are
// in-memory fakes — generation never serves a request or touches the
// network, it only needs an app instance to read the document from.
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "openapi", "openapi.json");

const app = await buildApp({ config: loadConfig(), deps: fakeDeps() });
await app.ready();
const document = JSON.stringify(app.swagger(), null, 2);
await app.close();

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${document}\n`);
console.log(`wrote ${out}`);
