# Changelog

All notable changes to PrintNinja are documented here. The format is based on Keep a Changelog.

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
- **Share service** (`server/` crate, `axum` + `rusqlite`/`Turso`): `POST /v1/auth/{register,login,logout}`, `GET /v1/auth/me`, `PUT/DELETE /v1/templates/{id}` (client UUID, idempotent, owner 403, 404, size caps 512K body / 64K readme, remote-ref `data: URIs` check, server `updated_at`), `POST /v1/templates/{id}/use`, `PUT/DELETE/GET /v1/saved` (idempotent). Passwords via `scrypt` + per-user salt, sessions as 32B base64url sha256 30d, throttle 5/min per handle/IP, `CORS` permissive, `TURSO_AUTH_TOKEN` never in client.
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
