import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";
import { loadConfig, loadEnvFile } from "../src/config.js";
import { fakeDeps } from "../test/helpers.js";

// Writes the generated OpenAPI document to server/openapi/openapi.json
// (committed; CI fails when it drifts — REFACTORING.md section 10).
// Needs the same environment as the service itself (DATABASE_URL and
// CORS_ORIGINS at minimum); server/.env is loaded automatically, and
// explicitly-set variables always win. Deps are
// in-memory fakes — generation never serves a request or touches the
// network, it only needs an app instance to read the document from.
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "openapi", "openapi.json");

// server/.env next to this script's folder; explicit env wins.
loadEnvFile(resolve(here, ".."));

const app = await buildApp({ config: loadConfig(), deps: fakeDeps() });
await app.ready();
const document = JSON.stringify(app.swagger(), null, 2);
await app.close();

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${document}\n`);
console.log(`wrote ${out}`);
