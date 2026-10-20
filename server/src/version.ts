import { createRequire } from "node:module";

// The one place a version string comes from, so /v2/health, the OpenAPI
// document and the package cannot drift apart.
const require_ = createRequire(import.meta.url);

export const APP_VERSION = (
  require_("../../package.json") as { version: string }
).version;
