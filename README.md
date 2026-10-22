# PrintNinja

Silent print for Windows and Android — design HTML templates, fetch JSON data, print via IPP / raw TCP / USB / Bluetooth / system spooler, with history, batch, profiles, and automation.

![Tauri 2](https://img.shields.io/badge/Tauri-2-blue) ![React](https://img.shields.io/badge/React-18-blue) ![Rust](https://img.shields.io/badge/Rust-stable-orange)

## Features

- **Designer** — HTML/CSS (CodeMirror) + live canvas, page presets (A4, 80 mm roll, 4×6 label…), fit-to-width and manual zoom, Handlebars helpers (`currency`, `date`, `padLeft`…), `bwip-js` barcodes (14 symbologies → inline SVG), and data-driven `{{barcode "code128" order.id}}` / `{{qrcode order.url}}` helpers that print the same way as the preview (Code 128/39/93, EAN-13/8, UPC-A, ITF, Codabar, QR; options `width=`/`size=` in mm and `text=false`), custom fonts, version history with diff/restore, **README** tab next to HTML and CSS (markdown, 64 KiB cap) and **Publish** with a Draft/Published badge and an unpublished-changes strip. Compact view switcher; unpublish asks first and names the template.
- **Print** — choose printer, template, data source and copies on the left, one **Print** button (with the reason when it is disabled), live preview on the right. Orientation, fit, margins, page range, grayscale and the test page sit under **Advanced options**. Batch (JSON array or CSV with column mapping), per-printer profiles, clear success/failure banners with Try again.
- **Templates** — Mine and Saved as tables (status, page size, updated); Community stays a gallery with search and sort. Print and Edit straight from a row. Save, download as a read-only copy, and print offline.
- **Printers** — grouped Network, USB, Bluetooth and System; test print per row; setup in a side panel (IPP / raw TCP 9100, language, paper, DPI). Status shows only when known.
- **History** — sticky filter bar (status, source, printer, search, dates), saved filter sets, bulk reprint and retry (each confirmed), CSV export, retention.
- **Automation** — local REST API (`axum`, `127.0.0.1:17717`, Bearer + idempotency, CORS scoped, LAN off by default) and `printninja://` deep links with trust list and confirmation sheet
- **Share** — hosted `server/` (TypeScript Fastify + PostgreSQL via Prisma, `argon2id` with scrypt fallback) at `share_service_url` + `share_session_token` (Settings → Share: Register/Login/Logout, handle `alphanumeric+_-` 1–32, password ≥8), `/v2` API: auth, templates (client UUID, revisions with `428`/`409`, publish/unpublish), Community, Saved, delta sync, sample datasets, printer profiles, fonts and account preferences; every failure uses the `{ error: { code, message, details?, request_id } }` envelope (`server/openapi/openapi.json` is the contract)
- **Corporate UI** — one light theme in a restrained slate teal; IBM Plex bundled for identical rendering on every workstation, offline. One status vocabulary (colour + icon + word) on every screen. `Ctrl/Cmd+K` palette, `G` then `P/H/D/T/R/S` navigation, full keyboard path, WCAG 2.1 AA as the internal bar. **Comfortable/Compact density** and optional **name and logo** in Settings → General; **Settings → Setup** checklist for admins. See [`docs/UI_GUIDE.md`](docs/UI_GUIDE.md).
- **Queue** — per-printer `Semaphore` (no byte interleaving), bounded admission, `POST /v1/print` runs the same pipeline as the UI

## Tech Stack

| Layer | Choice |
|---|---|
| App shell | Tauri 2 (Windows + Android) |
| UI | React 18 + Vite 6 + TypeScript 5 + Tailwind 3 + shadcn/ui + Zustand + TanStack Query/Table, IBM Plex via `@fontsource` |
| DB | SQLite (`tauri-plugin-sql` migrations + `rusqlite` commands) — 9 tables |
| Template | Handlebars (singleton registry), each template version stores its own Tailwind CSS (`compiled_css`), compiled in the app by Tailwind v4 `compile()` from the classes the template uses; `buildTemplateCss` inlines it after a small base layer |
| Barcodes | `bwip-js` `toSVG()` (inline SVG, no canvas data-URI) |
| Markdown | `react-markdown` + `remark-gfm` (no `rehype-raw` → XSS as text, links `http/https/mailto` only) |
| Sanitize | `sanitize.ts` + `handlebars.rs` strip `<script>`/`on*`, `find_remote_refs` → `data: URIs`, CSP `default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:`, `sandbox=""` iframes |
| API | `axum` + `tower-http` (local `127.0.0.1:17717` — API-key scopes and, when set, an IP allowlist are enforced) |
| Share service | `server/` (TypeScript, Fastify 5 + Zod 4, PostgreSQL 16 via Prisma 7, `argon2id` + scrypt fallback) — auth, templates, Community, Saved, delta sync, datasets, profiles, fonts, preferences over `/v2`; every failure uses the `{ error: { code, message, details?, request_id } }` envelope (`server/openapi/openapi.json` is the contract) |
| Secrets | No keyring: the share-session token is plain text in the local `settings` table (moving it to an OS key store is a follow-up). `rendered_html` is secret-redacted before it is stored in `print_jobs` |
| Android | Kotlin plugins: WebView → PDF, `UsbManager`, RFCOMM |

## Architecture

```
UI (Designer + README + Templates / Print / PrinterSetup / History) ──invoke()──► Rust core
  Designer: controls accordion + HTML/CSS/README editor + canvas + Publish (remote_id/published_at)        Data fetcher → Handlebars (sanitize + CSP) → Layout (@page) → PDF → Queue (per-printer) → Transport → History
  Templates: Community (search/sort, offline) / Mine (Draft / Published badge) / Saved / Withdrawn badges  Share client ──fetch──► server (`share_service_url` + Bearer)
REST API ──┐
Deep link ─┼──► same queue/pipeline (idempotency, copies, redaction)
Batch ─────┘
```

`DbState = Arc<Mutex<Database>>` (`sqlite:` URL → `rusqlite` path) is `manage()`d as Tauri state; `PrintQueue` is `Clone + Send + Sync` with `Arc<Mutex<HashMap<String, Semaphore>>>`; `PrinterTransport::discover(&self)` is `dyn`-dispatchable via `TransportRegistry`.

## Data Model

App SQLite (`src-tauri/src/db/schema.sql` + `db::ensure_v2_schema`): `printers` · `templates` (`readme`, `summary`, `remote_id` UUID, `published_at`, `origin` `own`/`saved`, `origin_owner`, `withdrawn`, `idx_templates_remote`) + `template_versions` · `fonts` · `printer_profiles` · `batches` · `print_jobs` · `api_clients` · `settings` (`share_service_url`, `share_session_token`, `onboarding_done` etc.). Two tables the code never used — `sample_datasets` and `presets` — are gone; an upgrade drops them (they were always empty). The `retention_days` preference is stored but not implemented: history is never pruned.

Share service PostgreSQL (`server/prisma/schema.prisma`, migrations run on boot): `users` (handle, case-insensitive unique handle key, `argon2id` hash with scrypt fallback) · `sessions` (token-hash PK, expiry) · `templates` (client UUID PK, revisions, change sequence, publish times) · `template_versions` · `saved_templates` · `sample_datasets` · `printer_profiles` (one per template + lowercase printer name) · `user_settings` (allow-listed keys only) · `fonts` + `font_files` (magic-checked bytes, SHA-256) · `tombstones` + per-user change sequence (delta sync).

## Project Structure

```
src/                         # React
  pages/Designer (controls/editor/canvas + Publish)  Templates (Community/Mine/Saved)  Print  PrinterSetup  History  Settings (Share)
  components/ui  Layout  designer/{ControlsAccordion,EditorPane,CanvasWorkspace,CanvasPane,…}  ReadmeEditor
  lib/{store,render{renderTemplate,sanitize},templates,share/client,hooks,utils}
src-tauri/src/
  commands/{print,printer,template{readme, publish info, origin},version,history,batch,font,profile,settings,api}
  api/{routes,auth,openapi}  queue.rs  transport/{...}  data/fetcher.rs  deeplink.rs  render/handlebars.rs (sanitize)  db (ensure_v2_schema)  readme.rs
server/                      # share service, TypeScript (REFACTORING.md Phase 3: cut over)
  src/{server.ts, app.ts, config.ts, http/{plugins,routes,schemas}, domain/{auth,errors,ports}, infra/{prisma,security}}
  prisma/{schema.prisma, migrations}  test/{unit, integration, e2e}  openapi/openapi.json
e2e/                         # Playwright suite (app in Chromium + harness service)
  support/{stack.ts, fixtures.ts, api.ts, testids.ts, fakeAgent}  tests/smoke.e2e.ts
```

## Getting Started

```bash
pnpm install
pnpm dev --host 0.0.0.0   # http://localhost:1420  (LAN http://<ip>:1420)
cargo test --manifest-path src-tauri/Cargo.toml
```

Prerequisites: Node 22, Rust stable, pnpm 10; for Android: Java 17, Android SDK/NDK 27+.

### Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` | Vite dev server |
| `pnpm build` | `tsc -b && vite build` |
| `pnpm lint` / `pnpm format` | Biome (app `src/`, `server/src`, `server/test/`, `e2e/`) |
| `pnpm test` | Vitest (jsdom) |
| `pnpm gen:api` | regenerate `src/lib/api/schema.d.ts` from the committed OpenAPI document (CI fails on drift) |
| `pnpm e2e` | Playwright smoke (app in Chromium vs the harness stack) |
| `pnpm --filter server dev` | v2 service with reload (`tsx`, needs `DATABASE_URL` — see below) |
| `pnpm --filter server test` / `test:unit` / `test:int` | unit + integration / unit only / integration only (Testcontainers PostgreSQL) |
| `pnpm --filter server test:e2e` | E1/E8 over HTTP against `E2E_BASE_URL` (default `http://localhost:3001`, needs `docker compose up -d` from `server/`) |
| `pnpm --filter server db:migrate` / `db:generate` / `db:validate` | apply migrations / build the Prisma client (gitignored, always generate on a fresh clone) / validate the schema |
| `pnpm --filter server openapi:generate` | regenerate `server/openapi/openapi.json` (CI fails on drift) |
| `docker compose up -d` / `down -v` (from `server/`) | v2 service + PostgreSQL (migrates itself on boot, healthy at `:3001/v2/health`) |
| `cargo test` (in `src-tauri`) | Rust (lib + integration) — `CARGO_INCREMENTAL=0 cargo test` on low-disk hosts |

### Share service

The hosted counterpart to the app's local cache. Auth: register `201`, login `200`, logout `204`, me `200`; duplicate handle `409 handle_taken`; unknown handle and wrong password both `401 invalid_credentials`; brute force limited to 10 attempts per 5 minutes per IP and handle (`429` + `Retry-After`); passwords 8–128 chars, handles 1–32 of `A–Z a–z 0–9 _ -`, matched case-insensitively. Legacy `scrypt` passwords verify and are rehashed to `argon2id` on first login.

```bash
cd server
cp env.example .env   # usable defaults; edit POSTGRES_PASSWORD for anything shared
docker compose up -d     # postgres:16 + service, migrates on boot
curl localhost:3001/v2/health
```

To use your own PostgreSQL instead of the bundled container, set
`DATABASE_URL` in `server/.env` and start only the server
(`docker compose up -d --build --no-deps server`) — see
`docs/RELEASE.md` ("Using an external PostgreSQL").

Configuration is environment-only (nothing auto-loads; development passes `--env-file`). All variables are listed in `env.example`: `DATABASE_URL` (PostgreSQL), `CORS_ORIGINS`, `HOST` (`127.0.0.1` local, `0.0.0.0` in containers), `PORT`, `SESSION_TTL_DAYS`, `SESSION_CLEANUP_MINUTES`, `RATE_LIMIT_MAX`, `RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_AUTH_WINDOW_SECONDS`, `ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM`, `DOCS_ENABLED`, `LOG_LEVEL`. The service fails fast naming the offending variable; the Dockerfile and CI generate the Prisma client with a dummy `DATABASE_URL` because generation never connects.

## Building

```bash
pnpm tauri:build              # Windows MSI (x86_64-pc-windows-msvc)
pnpm tauri:build -- --target aarch64-linux-android   # Android (arm64)
```

CI builds MSI only and Android `aarch64` only (unsigned, attached to a draft GitHub Release on `v*` tags); signing is local-only (`docs/RELEASE.md`, `scripts/release.sh`).

## REST API

Disabled by default, `127.0.0.1:17717`. `Authorization: Bearer pn_live_…`, optional `Idempotency-Key`. `POST /v1/print` requires `template` + `printer` + `data` and reports the real outcome (`200` success, `400` missing template, `404` printer/template, `500` transport). `GET /v1/openapi.json` is the contract (also behind auth).

## Deep Links

`printninja://print?template=…&printer=…&url=…&copies=…` etc.; `printninja://open/history`, `printninja://template/{id}`. Confirmation sheet unless source is trusted.

## Testing

- `vitest` — barcode SVG vs data-URI, encoder-name mapping, template helpers, Tailwind bundle safelist drift, history CSV/date logic
- `cargo test` — queue serialisation/parallelism, `Box<dyn PrinterTransport>` dispatch, idempotency, `print_runs_the_real_pipeline` (was lying `202 queued`)

## License

Proprietary — all rights reserved. See `CONTRIBUTING.md` for development notes.
