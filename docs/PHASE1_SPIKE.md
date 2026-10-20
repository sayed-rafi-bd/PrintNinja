# Phase 1 spike results (2026-10-20)

One-day spike for `REFACTORING.md` §12 Phase 1. Five assumptions were untested;
all five are now proven on this machine (Debian 13 LXC, Docker available, Node
24 local / Node 22 in CI and the image). Runnable artifacts: the `server/`
skeleton (5 Vitest tests), `e2e/tests/spike-signin.e2e.ts`, and the scripts
referenced below. Results and the decisions they fix:

## 1. Route + Zod + OpenAPI 3.1 — PROVEN (with one fix)

- Pinned in `server/package.json`: fastify 5.12.7, fastify-type-provider-zod
  7.0.0, @fastify/swagger 9.9.2, @fastify/swagger-ui 6.1.2, zod 4.6.7,
  validator `@seriousme/openapi-schema-validator` 2.11.0.
- One route (`GET /v2/health`), generated document validates against the
  official OpenAPI 3.1 meta-schema; `/openapi.json` and `/docs` serve.
- **Finding:** `@fastify/swagger` alone serialises raw Zod objects into the
  document (`def`/`shape` junk that the meta-schema tolerates as unknown
  keywords but that means nothing to consumers). The fix —
  `transform: jsonSchemaTransform` from fastify-type-provider-zod — is wired
  in `server/src/app.ts` and pinned by a regression test. `app.swagger()`
  also requires `await app.ready()` first.

## 2. argon2 + Prisma + pnpm allow-list on the Docker base image — PROVEN

- **Base image chosen: `node:22-bookworm-slim`** (Debian, glibc; argon2's
  prebuilt binary and Prisma's `schema-engine-debian-openssl-3.0.x` both work).
  Alpine/musl is deliberately untested — stay on Debian.
- The spike image installs with `pnpm install --filter server --frozen-lockfile`,
  runs `prisma -v` (CLI + schema engine), then as the non-root `node` user
  hashes and verifies with argon2. All green.
- **Allow-list (exact, confirmed by pnpm's own warnings):** `esbuild`,
  `argon2`, `prisma` (its script is `preinstall`), `@prisma/engines`.
  **Playwright needs no entry** — `@playwright/test`/`playwright` have no
  install script; browsers come from `playwright install` (§12's expectation
  corrected). The repo's `allowBuilds:` key form works on pnpm 10.34.7.
- Local pnpm was aligned to CI (`npm i -g pnpm@10` → 10.34.7, lockfile
  stays `lockfileVersion: 9.0`). pnpm 12 must not install in this workspace:
  it purges `node_modules` between majors.

## 3. A real Rust scrypt hash verifies in Node — PROVEN

- Real hash from `server-legacy` (`POST /v1/auth/register`, read from SQLite):
  `$scrypt$ln=17,r=8,p=1$…` → N=131072, r=8, p=1 → **128 MiB** of memory.
- Node's default `maxmem` (32 MiB) fails with `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`,
  exactly as the plan predicted. With `maxmem: 256 MiB`: correct password
  verifies in **403 ms**, wrong password rejected (PHC base64 is the standard
  alphabet with padding stripped; `Buffer.from(s, "base64")` handles it).
- Consequences recorded: the auth rate limit stays mandatory (D13's
  verify-once-then-rehash-to-argon2id means a legacy user pays 403 ms and
  128 MiB on exactly one login).

## 4. Tauri IPC shim + Vite serves the sign-in screen — PROVEN

- `window.__TAURI_INTERNALS__ = { invoke }` is the correct shape for the
  `@tauri-apps/api` 2.2 in `package.json`: `e2e/tests/spike-signin.e2e.ts`
  boots the real app under Vite (1420) with `e2e/support/fake-agent.mjs`,
  which answers `get_setting` (`onboarding_done=true` skips onboarding,
  `share_service_url` points at a running API, no session token), the gate
  probes `<url>/health` (`server-legacy` has `CorsLayer::permissive()`, so
  the cross-origin fetch from the browser works), and
  `#auth-handle`/`#auth-password` become visible. The test also asserts the
  agent actually saw the `get_setting` call, so a wrong shim shape fails the
  test instead of being swallowed by the boot path's `.catch(() => null)`.
- Playwright 1.64.1 installed into `e2e/`; `playwright install chromium`
  downloads the matching browser (two older revisions in the cache are
  stale and reclaimable).

## 5. Per-user change sequence under 20 concurrent writers — PROVEN

- `postgres:16` container, 20 connections × 15 transactions = 300 records,
  random 1–10 ms hold inside each transaction, a polling reader with a
  cursor running throughout (the same read shape as `GET /v2/sync/changes`).
- **Row-lock design (§7): 300/300 observed, zero holes — the reader never
  skipped a record.**
- Negative control with a global sequence (`nextval`, same timing): the
  reader observed only 158/300 with holes — proving the test can detect the
  skip it is supposed to rule out, and that the rejected design fails as
  §7 reasoned.
- The spike script was throwaway; the durable version arrives with the
  integration suite (Testcontainers) in the sync deliverable.

## Import-rule tool (spike decision for deliverable 2)

**dependency-cruiser** (`server/.dependency-cruiser.mjs`, `pnpm --filter
server arch`): purpose-built for layer rules, parses TypeScript, no second
lint stack next to Biome. Rules encode §5: `domain` imports neither `http`
nor `infra`; `http` never imports `infra`; `infra` never imports `http`; no
`@prisma/client` or `infra/prisma/generated` outside `infra`. Verified
red→green: a seeded violation file produced `exit 1` with both rules firing;
the skeleton cruises clean.

## Also learned (feeds the Prisma deliverable)

- Prisma 7.10.1 loads **both** `prisma.config.ts` and `prisma7.config.ts`
  (the former is the plan's choice; it wins when both exist — §12's open
  question answered).
- Prisma 7 rejects `url` inside `datasource` in the schema file: connection
  URLs for migrate live in `prisma.config.ts` (`adapter` / `accelerateUrl`).
  The schema and config shapes follow section 5's layout when the Prisma
  setup lands.
