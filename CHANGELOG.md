# Changelog

All notable changes to PrintNinja are documented here. The format is based on Keep a Changelog.

## [Unreleased] — Online-only server migration

### Added
- **Vercel deployment for the share service (`server/` on `main-vercel`).** `server/api/index.ts` builds the same Fastify stack per cold start and forwards requests into it — no `listen()`, timers or shutdown hooks (all stay in `src/server.ts` for Docker/local). Remote Turso URLs go through the fetch-only web client and driver adapter, so serverless runtimes never touch the native SQLite binding. New `GET /v2/internal/cleanup` (Bearer `CRON_SECRET`, 404 when unset) replaces the in-process purge timer; the daily `server-cleanup` workflow calls it, and `server-migrate` applies migrations on demand since there is no boot-time migrate. Pinned in `server/vercel.json` (Root Directory = `server`), documented in `docs/RELEASE.md`.

### Changed
- **Share service database: Turso Cloud in production, local SQLite files everywhere else.** `server/` no longer runs PostgreSQL: Prisma 7 now uses the SQLite provider through `@prisma/adapter-libsql`, one code path for `file:` URLs (development, integration tests, Playwright e2e, the bundled compose volume) and `libsql://` + `DATABASE_AUTH_TOKEN` (production on Turso Cloud). The repository layer, the `/v2` API and the OpenAPI contract are unchanged; Community search stays case-insensitive via `COLLATE NOCASE` columns (Prisma's `mode: "insensitive"` is PostgreSQL-only). Migrations are authored with `prisma migrate dev` and applied by a small boot runner (`pnpm --filter server db:apply`, also the container entrypoint) because `prisma migrate deploy` cannot reach a remote Turso database. `docker compose up` is now a single service; the old `POSTGRES_PASSWORD`/`db` container is gone, and the committed PostgreSQL migrations are archived under `server/prisma/migrations-postgres-archive/`. No data is carried over (fresh start, per the migration decision).


### Added
- **Automated print tests against a real printer endpoint.** `src-tauri/tests/virtual_printer.rs` drives the transports against the [Virtual Printer](https://github.com/sayed-rafi-bd/virtual-printer) (vendored from its `rust` branch under `e2e/support/virtual-printer/`, std-only, built on demand) and switches its fault state at will: a job that arrives, a paper-out, a jam, an offline device, one that accepts the connection and never answers, and one that closes it at once. Twelve tests cover the transport itself and the history row it leaves behind; twelve more unit tests pin the IPP response parsing. Nothing here needs Python, a network or a service, and none of it skips.
- **Full local reset (Settings → Retention).** "Reset this PC" erases everything the app owns on this PC — templates and versions, print history, printers, fonts and their files, datasets, profiles, the sync state and every setting including the sign-in — after an explicit confirmation, and returns the app to the welcome screen. The server is untouched: signing back in pulls the account down again.

### Removed
- **Legacy Rust share service (`server-legacy/`, Phase 3 cutover).** The hosted service is now `server/` only (TypeScript + Fastify + PostgreSQL, `/v2` API); the `server-test` CI job went with it. The `/v1` API is gone with no adapter — a clean break, per the answered question 2 (released tags never distributed the v1 client). To migrate an account off the old service, run the old server read-only, import with `pnpm --filter server db:import` (rehearsed by E9), compare counts, then point the app at the new address.

### Changed
- **A failed print now says why, and a hung one can no longer stay hung.** Three defects let a bad print count as a good one. Raw/JetDirect sends had no deadline at all, so a printer that accepted the connection and stopped reading left the job row `printing` forever with the UI spinning; they now have a 10 s connect and 30 s send deadline, and the job ends `failed` with a message naming the printer. IPP reported success whenever the *operation* status was successful, even when the response said `job-state = processing-stopped` for a jam, paper-out or pause — the job group is read now (`job-state` is an enum in four big-endian bytes, not the integer tag it was first written against). And the actual cause lives somewhere else: a Print-Job reply says `printer-stopped` whatever is wrong, while the specific condition is in `printer-state-reasons`, so a failed job now asks Get-Printer-Attributes once on a 10 s budget and reports "it is out of paper [media-empty]" instead of a bare IPP status hex. Timeout, unreachable and mid-flight disconnect are told apart too, so a printer that answered and then went quiet is no longer described as unreachable. Every message lands on the `print_jobs` row and is shown in Print and History.
- **A raw printer is now asked whether it can print, before the job goes out.** A raw/JetDirect printer answers a status query but never a job, so out-of-paper, jam and offline all arrived looking like a successful print — the bytes being accepted was the only evidence there was. The transport now asks in the printer's own command language (`src-tauri/src/transport/status.rs`): `DLE EOT 1..4` for ESC/POS (Epson's status bytes: offline, cover, paper end, errors), `~HS` for ZPL (line 1's paper-out and pause flags, read as text so an unrecognised field cannot fail a print), `ESC !?` for TSPL (the documented one-byte table, read as the bitmask it is). A fault refuses the job before a byte of it is sent and lands in `print_jobs.error` in the wording the IPP path already uses, evidence included: `the printer at 192.168.1.5:9100 did not print the job: it is out of paper [DLE EOT 4 = 0x72]`. Two things deliberately do not fail: an answer that cannot be read, and a *first* silence — a printer that has never answered may simply not implement the query, and a mis-set language column must not stop every print. A printer that has answered and then goes quiet does fail, naming media out, an open head or a paper jam, which is what Zebra's spec requires: a Zebra sends no `~HS` reply at all when media is out, the ribbon is out or the head is open. A printer that stops answering is not asked again for an hour, so silence costs one reply timeout rather than one per job. PDF, raster and CPCL printers are asked nothing and behave exactly as before.
- **Prints go through one persistent headless Edge driven over the DevTools protocol.** Every print used to start its own `msedge.exe`; now Edge is started once at launch (`render/cdp.rs`, own `edge-cdp-profile`, `--remote-debugging-port=0` on 127.0.0.1) and each PDF or raster job only opens a tab, loads its HTML, prints or screenshots it and closes the tab. Jobs run in tabs side by side, so concurrent prints no longer need throwaway profiles. Page size and margins still come from the document's `@page` rule, and web fonts are awaited before printing. If the persistent Edge cannot start or a render on it fails, that job falls back to the one-shot launcher exactly as before, and a failed start is not retried for 60 s. A previous run's leftover Edge is closed on start-up and Edge is closed when the app exits. Set `PRINTNINJA_EDGE_PERSISTENT=0` to use one-shot Edge only. Windows only.
- **Headless Edge is started and warmed up when the app launches.** The reusable `edge-warm-profile` was only initialised by the first print, so that print still paid for Edge's first-run set-up. Startup now renders a tiny throwaway page on that profile in the background (`render::warm_up_edge`). A print that arrives while the warm-up runs waits for it (up to 15 s) instead of building a cold throwaway profile; a failed or stuck warm-up (30 s limit) discards the profile and the first print falls back to the previous behaviour. Windows only; startup is never blocked.

### Fixed
- **The Designer flashed on screen before the Print page, most visibly right after creating an account.** The router mounted at `/` (the Designer) and only then redirected to `/print` from an effect, so the Designer rendered for a frame first. The starting address is now rewritten to `/print` before the router reads it (`startOnPrint`, `AppRouter`), so the Designer is never rendered on the way; deep links and later visits to the Designer are unchanged. The sign-in gate also no longer shows one blank frame between signing in and the app appearing.
- **Preview unavailable: `list_versions` missing required key `templateId`.** Tauri 2 converts Rust argument names to camelCase on the JS side, but the frontend (and the fake agent used by tests and e2e) sends snake_case, so every multi-word argument failed. The 18 affected commands (`list_versions`, `diff_versions`, `list_profiles`, `cache_mark_pushed`, `cache_mark_conflicted`, `cache_resolve_conflict`, `cache_queue_use`, `cache_forget_*`, `cache_mark_*_pushed`, `cache_read_font_file`, `cache_apply_changes`, `upload_font`, `start_api_server`) now declare `#[tauri::command(rename_all = "snake_case")]`, so the wire format matches the frontend and the fake agent. `pnpm check:tauri-args` (`scripts/check-tauri-args.mjs`, run in CI) now fails the build when a command with a multi-word argument lacks the attribute, because the unit and e2e tests use a fake agent that cannot catch it.

### Added
- **Data-driven barcodes and QR codes: `{{barcode "code128" order.id}}` and `{{qrcode order.url}}`.** Before, Insert Barcode pasted a fixed, pre-drawn SVG at the end of the HTML, so a label could not carry its own order number and `{{order.id}}` was encoded as literal text. The two helpers read the value from the data at render time, so every print and every CSV row gets its own code. Options: `width=` (barcode) or `size=` (QR) in mm, 5 to 200, and `text=false` to hide the digits. A missing or invalid value (an EAN-13 with a bad check digit, say) prints nothing instead of failing the job. They are implemented in the preview (bwip-js) and in the Rust print path (`src-tauri/src/render/barcode.rs`, `barcoders` + `qrcode`) so print matches the preview, for Code 128, Code 39, Code 93, EAN-13, EAN-8, UPC-A, ITF, Codabar and QR. Data Matrix, PDF417, Aztec, UPC-E and ITF-14 can still be inserted with a fixed value (static SVG, preview only). The Insert Barcode dialog now has a "Read the value from a data field" switch and inserts at the editor cursor.
- **Share service v2, Phase 1: foundation, auth, packaging, e2e harness** (`server/`, TypeScript + Fastify + PostgreSQL via Prisma). Auth endpoints `POST /v2/auth/{register,login,logout}` and `GET /v2/auth/me` plus `GET /v2/health`; every failure uses the `{ error: { code, message, details?, request_id } }` envelope, and `server/openapi/openapi.json` is the generated contract (CI fails on drift). Register answers `201`, a taken handle `409 handle_taken` (was `400`), unknown handle and wrong password both `401 invalid_credentials`; brute force is limited to 10 attempts per 5 minutes per IP and handle (`429` + `Retry-After`); expired sessions are purged at startup and hourly. Ships as a non-root multi-stage image with a `/v2/health` health check; `docker compose up -d` (service + PostgreSQL) migrates itself on boot. E1/E8 run over HTTP against the composed stack, and the Playwright smoke asserts the sign-in gate states. Legacy `scrypt` passwords verify and are rehashed to `argon2id` on first login.
- **Designer polish (layout plan, phase 3).** On desktop: a layout toggle in the header (side by side, stacked, canvas only); the editor/canvas split and the open accordion sections are remembered between launches; clicking a helper such as `{{currency}}` inserts it at the editor cursor; below 1440 px the controls column shrinks to a 48 px icon rail (click an icon to open that section, or use Expand/Collapse); and a red banner on the canvas says what is wrong while the template is half-typed (an unclosed `{{#each}}`, say).

### Changed
- **Printing reuses one Edge profile instead of building a new one per job.** Each PDF or label render starts headless Edge, and starting it on an empty profile every time was the slow part of a print. The first job to find the reusable profile free (`edge-warm-profile`, in the cache dir) now runs on it; a job that finds it busy, or whose run on it failed, uses a throwaway profile exactly as before, and a failed run also deletes the reusable profile so the next print starts a clean one. Two Edge processes never share a directory. The profile stays on disk between prints, so the startup sweep leaves it alone and the hardware checklist (section 4) now expects it. The launching code is in `src-tauri/src/render/edge.rs`, with unit tests that use a fake Edge.
- **Edge no longer blocks a tokio worker thread while it renders.** The render used the blocking `std::process::Command::output()` inside an `async fn`; it now uses `tokio::process`, and Edge is killed if the job is dropped mid-render.
- **Each print logs where its time went.** One `print job timing` line per job gives `fetch_ms`, `template_ms`, `layout_ms`, `render_ms`, `send_ms` (queue wait included), `history_ms` and `total_ms`, and the existing `rendered PDF with Edge` line adds `edge_ms`, `profile_cleanup_ms` and `warm_profile`. A failed render logs `print render failed` with the same timings.
- **The only bundled starter template is now Shipping Label 4x6** (was Receipt 120mm). It is what a fresh install seeds and what the Designer falls back to. Existing installs keep the templates they already have.

### Added
- **Per-template Tailwind CSS.** Each template version now carries a stylesheet compiled from the classes it actually uses, so any Tailwind class works, including arbitrary values such as `w-[37mm]`, `bg-rose-500` and `grid-cols-5`. Before, only the Designer's fixed palette had rules and anything else silently did nothing. Compilation runs in the app (Tailwind v4 `compile()`, installed as the `tailwind4` alias) when a template is saved, seeded, refreshed or downloaded; the result is stored as `compiled_css`/`compiled_key` on `template_versions`, and previews and the Rust print path inline the same CSS.
- To style from data, write each full class in every branch (`{{#if urgent}}bg-red-600{{else}}bg-green-600{{/if}}`) or use a CSS variable. Class names built at render time (`bg-{{color}}-500`) cannot be compiled, and the Designer warns about them.
- **Save to server** (migration phase 1). The Designer and every Templates row push the local copy to the server, HTML and CSS together. A first Save stores the template private; Publish makes it visible in Community as before. `remote_id` comes back and links the two copies.
- **Refresh from server**, one button per template, asks first because it overwrites unsaved local edits. On success it rewrites the local HTML, CSS, README, name, page size and summary; on failure it says so and leaves the local copy alone, so it still prints.
- **Get from server** dialog on Templates: lists the account's own templates and the ones saved from Community, and adds the chosen ones to this PC with their CSS and README. This is how a new PC gets its templates.
- **"Cannot reach the server" screen** with Retry and Change server address, shown when the server is down as the app starts.
- A 401 from the server, or signing out, returns to sign-in. The app stays loaded behind the sign-in screen, so edits that are not saved yet are still there after signing in again.
- Once the app is open the gate never blocks on the network, so printing keeps working if the server goes away.
- Sign-in gate (migration phase 2): the app opens on a sign-in and register screen until the server accepts a session. The screen includes the server address, so a new PC can be set up without visiting Settings first.

### Removed
- **Designer: Visual tab, Preview tab and Properties card.** The Visual tab (GrapesJS) rewrote templates through the browser's HTML parser, which moves Handlebars loops out of tables, and it loaded its code from `unpkg.com` at run time. The Preview tab duplicated Canvas but ignored the chosen sample data and zoom. Properties repeated Page Setup and the zoom buttons. Saved templates are unaffected.
- The shared, safelisted print bundle: `tailwind.templates.config.ts`, `scripts/build-template-css.mjs`, `src/styles/templates.src.css`, `src/lib/templates/templates.generated.ts`, `src-tauri/assets/template-print.css`, and the `build:templates:css` / `prebuild` scripts. Only the small base layer (reset, page-break helpers, barcode) remains.

### Changed
- **Designer: new desktop workspace** (phase 2 of `docs/DESIGNER_LAYOUT_PLAN.md`). From `lg` (1024 px) up, the controls accordion (Templates, Page Setup, Sample data, Versions, Helpers; several open at once, only Page Setup open at first), the editor (HTML, CSS and README tabs) and the canvas sit side by side, with a draggable split between editor and canvas. The page no longer scrolls; each pane does. Typing in either editor updates the canvas without switching tabs. Below `lg` the tabs remain (Canvas, Code, README, Sample data), with Templates, Page Setup and Versions in a collapsed accordion above them. The old Variables tab is now **Sample data**, and Quick Helpers moved into the accordion.
- Designer: the canvas toolbar now holds the zoom controls, with a new **Fit** option (the default) that sizes the page to the width available, never above 100%. Zoom now scales the page rather than resizing it, so a zoomed page no longer reflows its content.
- Designer: the sync bar (Draft/Published, Save, Refresh, Publish) now sits under the page title instead of above the canvas, and **Save & Preview** returns to the Canvas tab. The page is split into `ControlsAccordion`, `EditorPane` and `CanvasPane` under `src/components/designer/` (`DesignerSidebar` is now `ControlsAccordion`). First step of `docs/DESIGNER_LAYOUT_PLAN.md`.
- Template CSS is stored on the server and returned with the HTML. Until now a published template lost its CSS on the way to another PC.
- The Designer's publish strip is now a sync bar: Draft or Published, then **Save to server**, **Refresh from server** and **Publish to Community** / **Unpublish**. Each button says while it is working.
- **Saved (community) copies are read-only.** They show Print, Refresh and Remove; there is no Edit, Save or Publish, and the Designer explains that they cannot be changed. Saving a copy now brings its CSS and README across too.
- Templates rows show where a template stands: *Not on the server*, *Private*, *Published*, or *Changes not saved* when the local copy has edits the server has not.
- A saved copy whose template is no longer on the server is marked *Withdrawn by author* in the tab, without touching the local row.
- Share client requests go through one `authedFetch` helper that ends the session on 401 and reports an unreachable server as `ServerUnreachableError`. New helpers cover Get, Refresh, Save and the saved-template list.

### Fixed
- **The desktop app builds again.** `src-tauri/Cargo.toml` held a copy of the server's manifest, so the app crate failed to compile (`tauri_build` not found) and no desktop build, bundle or Rust test could run. The Tauri manifest is restored and matches `Cargo.lock`, which was intact. `cargo test` passes (133 tests).
- Rust tests for the new commands (`src-tauri/tests/template_sync.rs`) and a guard that the print path grows no HTTP client (`print_path_offline.rs`), the check the migration plan asked for.

## [0.5.0] - 2026-10-19 — Corporate UI (phases 0–6)

### Changed
- **New look.** Slate teal palette, IBM Plex Sans and Mono bundled with the app (no dependence on installed fonts), 6 px radius, flat cards, one light theme. Dark mode and the theme selector are removed. Text and control colours meet WCAG 2.1 AA.
- **One status vocabulary.** Printed, Failed, Queued, Printing, Cancelled, Draft, Published, Saved, Withdrawn, Online and Offline each have one colour, icon and word everywhere (`StatusBadge`). This replaces the per-screen emerald/amber/violet/slate colours described in the 0.2.0 to 0.4.0 entries below.
- **New shell.** Top bar with search (`Ctrl/Cmd+K`), share-service status and help; sidebar grouped Work, Build, Admin; bottom bar on phones. Shortcuts: `?` and `G` then `P`, `H`, `D`, `T`, `R`, `S`.
- **Pages reworked.** History, Templates and Printers use tables with row actions; Print puts printer, template and the Print button on the left and a live preview on the right; Settings has a section list; the Designer toolbar, sidebar and publish bar are separate components.
- **Shorter welcome screen.** First run shows the three operator steps and two exits: Start printing, or Set up this workstation. Printer, template, API and sharing setup moved to Settings → Setup.

### Added
- **Settings → Setup checklist** with live status for printer, template and test print, plus optional retention, REST API and share service steps. Reachable at `/settings?section=setup`.
- **Density** (Settings → General): Comfortable (default) or Compact. Touch screens always keep the larger controls.
- **Branding** (optional, Settings → General): app name and logo for the top bar, window title and welcome screen. Defaults to PrintNinja.
- **Window chrome.** The Windows title bar is forced light and the window background matches the app. `scripts/patch-android-theme.mjs` gives the generated Android project light status and navigation bars; CI runs it after `tauri android init`.
- Command palette, shortcuts dialog, `ConfirmDialog` that names what it deletes, `/__ui` component reference (dev builds only).
- Tests: route smoke tests with axe on every page, colour-contrast checks from the token values, a guard against raw palette colours, plus tests for density, branding, setup checklist, onboarding and the Android patch.

### Fixed
- Printers: the Wi-Fi filter matched nothing because printer types are `ipp` and `raw_tcp`.
- Templates: **Print** only showed a toast, and Community **Preview** said "not implemented". Both now work.
- The Templates nav label showed `nav.templates`.
- 14 Select controls had no accessible name; heading levels skipped from `h1` to `h3`.

### Notes
- No change to print output: `templates.src.css` and `templates.generated.ts` are byte-identical, and the Rust core, REST API and share service are untouched.
- Version numbers: earlier entries (0.2.0 to 0.4.0) were never written to `package.json`, which stayed at 0.1.4. This release sets `package.json`, `Cargo.toml` and `tauri.conf.json` to 0.5.0 so they match this changelog.
- A new `src-tauri/capabilities/default.json` allows the window title to change (branding). Existing app commands are not affected.
- Not included: translations (strings stay in English), live printer reachability checks.

## [0.4.0] - 2026-10-18 — Phase 3: Sharing (B5+B6)

### Added
- **Community library** (`/templates`): Browse published templates from all users with search (name/summary), sort (Recently updated / Most used / A–Z), and pagination. Anonymous browse is public; offline shows an offline state.
- **Saved templates**: Save any Community template via the violet ★ (optimistic, idempotent `PUT /v1/saved/{id}`), download as a read-only local copy (`origin='saved'`, `origin_owner`), and print offline. Unsave via `DELETE /v1/saved/{id}`.
- **Use counter**: Printing a saved copy does `POST /v1/templates/{id}/use` (atomic `use_count = use_count + 1`, best-effort silent if offline) so Community sort by Most used reflects real prints.
- **Withdrawn state**: If an author unpublishes (`DELETE /v1/templates/{id}`), savers keep their local copy but see a slate “withdrawn by author” badge; the card still prints.
- **Template cards**: 4px left edge (cyan Published, amber Draft, emerald Community, violet Saved, slate Withdrawn), owner handle and print count, 1 col mobile / 2 col md / 3 col xl.

### Changed
- Navigation adds **Templates** (Library icon) between Designer and Print.
- `README.md` and this file document the share flow.

## [0.3.0] - 2026-10-18 — Phase 2: Identity & Publish (B3+B4)

### Added
- **Share service** (`server/` crate, `axum` + `rusqlite`/SQLite): `POST /v1/auth/{register,login,logout}`, `GET /v1/auth/me`, `PUT/DELETE /v1/templates/{id}` (client UUID, idempotent, owner 403, 404, size caps 512K body / 64K readme, remote-ref `data: URIs` check, server `updated_at`), `POST /v1/templates/{id}/use`, `PUT/DELETE/GET /v1/saved` (idempotent). Passwords via `scrypt` + per-user salt, sessions as 32B base64url sha256 30d, throttle 5/min per handle/IP, `CORS` permissive, no database credentials in the client.
- **App publish**: Designer header shows Draft (amber) / Published (emerald) chip, amber “You have changes that aren’t published” strip when `updated_at > published_at`, Publish (emerald) vs Update published copy + Unpublish (destructive). Service URL + token stored via `get_setting`/`set_setting` (fallback `localStorage`), Settings → Share tab (service URL, Register/Login/Logout, signed-in handle).

### Changed
- `templates` gains `remote_id` (UUID) and `published_at` (server `updated_at`) via `set_publish_info`/`clear_publish_info` (unpublish leaves local row intact).

## [0.2.0] - 2026-10-18 — Phase 1: Local (B1+B2)

### Added
- **Local schema + README** (`templates` gained `readme`, `summary`, `remote_id`, `published_at`, `origin` (`own`/`saved`), `origin_owner`, `withdrawn`, `idx_templates_remote`, all guarded via `PRAGMA table_info`): `create_template` now writes a scaffold (`# {{template_name}}` + 5 sections + `Changelog`) with `{{…}}` placeholder extraction from HTML, validated 64 KiB cap.
- **README editor** (`src/components/ReadmeEditor.tsx`): `react-markdown` + `remark-gfm` (no `rehype-raw` → XSS payload renders as text), links limited to `http`/`https`/`mailto` + `target="_blank"`, toolbar (bold/heading/link/code/list/quote), split `lg:grid-cols-2` / tabbed mobile, Reset to scaffold with confirm, byte counter.
- **Safe rendering** (`src/lib/render/sanitize.ts`, `src-tauri/src/render/handlebars.rs`): strip `<script>` and `on*` handlers, reject remote `src`/`href`/`url(http` with “use data: URIs”, CSP `default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:` injected in `renderTemplate`, `sandbox=""` on all preview iframes.

### Changed
- `Template` type now includes `readme`, `summary`, `remote_id`, `published_at`, `origin`, `origin_owner`, `withdrawn`.
- `print` and `handlebars` rendering is UTF-8 safe for symbols like `€`.

## [0.1.4] - 2026-10-17 and earlier

- V1: per-machine SQLite, Designer/Print/PrinterSetup/History/Settings, Handlebars helpers, `bwip-js` barcodes, per-printer queue, local REST API, deep links.
