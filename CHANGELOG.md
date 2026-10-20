# Changelog

All notable changes to PrintNinja are documented here. The format is based on Keep a Changelog.

## [Unreleased] — Online-only server migration

### Removed
- **Legacy Rust share service (`server-legacy/`, Phase 3 cutover).** The hosted service is now `server/` only (TypeScript + Fastify + PostgreSQL, `/v2` API); the `server-test` CI job went with it. The `/v1` API is gone with no adapter — a clean break, per the answered question 2 (released tags never distributed the v1 client). To migrate an account off the old service, run the old server read-only, import with `pnpm --filter server db:import` (rehearsed by E9), compare counts, then point the app at the new address.

### Added
- **Share service v2, Phase 1: foundation, auth, packaging, e2e harness** (`server/`, TypeScript + Fastify + PostgreSQL via Prisma). Auth endpoints `POST /v2/auth/{register,login,logout}` and `GET /v2/auth/me` plus `GET /v2/health`; every failure uses the `{ error: { code, message, details?, request_id } }` envelope, and `server/openapi/openapi.json` is the generated contract (CI fails on drift). Register answers `201`, a taken handle `409 handle_taken` (was `400`), unknown handle and wrong password both `401 invalid_credentials`; brute force is limited to 10 attempts per 5 minutes per IP and handle (`429` + `Retry-After`); expired sessions are purged at startup and hourly. Ships as a non-root multi-stage image with a `/v2/health` health check; `docker compose up -d` (service + PostgreSQL) migrates itself on boot. E1/E8 run over HTTP against the composed stack, and the Playwright smoke asserts the sign-in gate states. Legacy `scrypt` passwords verify and are rehashed to `argon2id` on first login.
- **Designer polish (layout plan, phase 3).** On desktop: a layout toggle in the header (side by side, stacked, canvas only); the editor/canvas split and the open accordion sections are remembered between launches; clicking a helper such as `{{currency}}` inserts it at the editor cursor; below 1440 px the controls column shrinks to a 48 px icon rail (click an icon to open that section, or use Expand/Collapse); and a red banner on the canvas says what is wrong while the template is half-typed (an unclosed `{{#each}}`, say).

### Changed
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
