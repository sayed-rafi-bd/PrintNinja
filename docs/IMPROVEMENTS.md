# Improvements & E2E testing backlog

> Status (feat/improvements-backlog): slices 1–11 are implemented —
> print page_range/grayscale end-to-end (Rust+REST+OpenAPI+tests),
> server body limits + /v2/ready (Docker healthcheck probes it),
> auth timing-oracle fix + 20-session cap + Argon2 clamps, domain byte
> caps + version label/note limits + dataset depth guard,
> tombstone→user cascade, settings PUT status from the repository,
> shared ETag matcher, restore nullish bodies, profile error details in
> wire names, sync hasMore per-stream + batched head versions,
> paged saved manifest under savedRoutes. Everything below that is
> still open.

Audited from the working tree (develop). Each item names the file that proves it.
Priorities: **P0** = correctness/security/data-loss, **P1** = UX/perf/tech-debt with user impact, **P2** = hardening/polish.

## 1. Frontend (`src/`)

### Print — P0: options collected but never sent
- `src/pages/Print.tsx:367-386` `handlePrint` sends `margin_*`, `orientation`, `fit_mode` but drops `store.pageRange` (`:722-724`) and `store.grayscale` (`:777-784`). Same omission in `handleSpikeTest` (`:403-421`).
- Fix: include both in the payload; add a Vitest that fails when a visible control is not wired to the request.

### Print — P0: preview lies
- `src/pages/Print.tsx:160-167` preview always uses `DEFAULT_MOCK_DATA`, ignores `store.dataUrl` / `useTestData=false`.
- Fix: render preview from the same resolved data as the print path, with an explicit "sample data" badge when falling back.

### Print — P1: batch CSV is lossy
- `src/pages/Print.tsx:194-230` hand-rolled parser `trim()`s every cell (kills significant zeros in EAN-13/Codabar), no size cap, no encoding check, no column-mapping UI despite README claiming it.
- Fix: use a real CSV parser (e.g. Papa Parse), preserve raw cell text, cap rows/bytes, add column→field mapping. Test with `00123`, quoted commas, BOM.

### Print — P1: poller leak, no progress
- `src/pages/Print.tsx:188-192` re-creates the 5s `list_batches` poller on every dialog open/close and keeps polling when closed. No inline batch progress, only toasts (`:300-318`, `printerId = Number(p.id)||0` fallback is falsy-bug-prone).
- Fix: start/stop poller with dialog visibility, show per-batch queued/printing/done/failed + cancel/retry inline.

### Designer — P0: silent data loss, no delete
- `src/pages/Designer.tsx:270-346` `loadTemplate` overwrites `htmlCode/cssCode/...` with formatted server copy and toasts success — no dirty-check, unsaved edits lost.
- `src/pages/Designer.tsx:496-555` `createNewTemplate` exists but there is no `delete_template` anywhere; duplicate-name check is in-memory case-insensitive only, not DB.
- Fix: dirty guard + confirm before load, add delete flow, enforce uniqueness server-side.

### Designer — P1: wrong editor, dead dep, version spam
- `src/pages/Designer.tsx:557-564,1507` JSON dataset dialogs use `CodeMirror extensions={[html()]}` — HTML highlighting for JSON, no JSON validation until save.
- `src/pages/Designer.tsx:1290-1355` diff dialog uses two `<pre>` blocks while `react-diff-viewer-continued` (`package.json:59`) ships unused.
- `src/pages/Print.tsx:138-156` preview side-effect writes `create_version{note:"Compiled Tailwind CSS"}` on every uncompiled view — version spam.
- Fix: JSON language mode + schema check on edit; either use the diff dep or drop it; only persist compiled CSS when the user saves.

### History — P1: search/export/confirm gaps
- `src/pages/History.tsx:133-162` search covers `source_url/error/id/batch` only — no printer name, no `template_id`. `HistoryFilter.isTest` has no UI control.
- `src/pages/History.tsx:243-269` CSV export omits `time/template/batch/copies/timings`, writes raw `printer_id` instead of `printerName`.
- `src/pages/History.tsx:167-178` vs `:690-706` single reprint/retry fires without confirm, bulk requires confirm — inconsistent for a physical action.
- Fix: extend search keys, add isTest toggle, export the full row, confirm all reprint/retry.

### Templates — P1: N+1, search storm, preview drift
- `src/pages/Templates.tsx:103-126,572-578` every search keystroke fires `fetchCommunityTemplates` — no debounce/abort.
- `src/pages/Templates.tsx:146-174` Saved tab does `for (tpl of saved) await fetchRemoteTemplate` — serial N+1, no concurrency limit.
- `src/pages/Templates.tsx:286-308` `openPreview` drops template `css` when calling `renderTemplate` — preview ≠ Designer/Print.
- `src/pages/Templates.tsx:723-730` `ConflictDialog` shows only `conflicts[0]`.
- Fix: debounce 250ms + AbortController, bounded parallel fetch, pass css through, paginate conflicts.

### PrinterSetup / Settings — P1: validation + dead UI
- `src/pages/PrinterSetup.tsx:189-231` validates only `ipp` prefix; `raw_tcp` accepts anything; `paper_width_mm/dpi` are fixed selects with no custom value; `Number(...)` without `isFinite`. No edit flow, only delete+re-add.
- `src/pages/Settings.tsx:843-948` + `README.md:50`: `retention_days/max_records` UI saves but "history is never pruned" — dead UI. Either implement pruning or remove the controls.
- `src/pages/Settings.tsx:308-324` trusted-source add/remove writes raw `localStorage/SQLite` while load uses `agent("get_trusted_sources")` — bypasses `set_trusted_sources`, format-mismatch risk.
- `src/pages/Settings.tsx:815-823` `allowed_domains` saves on blur with no toast/validation; empty = allow-all with no confirm.
- Fix: shared Zod schema for printer add/edit, wire retention to a real purge job, single trusted-source path, explicit allow-all confirm.

### Tech debt — P1
- `src/pages/Settings.tsx:54-79` duplicates `src/lib/settings.ts:10-36` (two caches diverge). Single module.
- `src/lib/store/templateStore.ts:18-38` and parts of `src/lib/store/printStore.ts:31-48`, `historyStore.ts:22-23` are dead or write-only (only touched by tests). Delete or wire up.
- `src/lib/render/sanitize.ts:22-37` regex sanitizer misses `srcset`, `style="...javascript:..."`, `<svg><animate onbegin=...>`, `<form formaction=...>`; `findRemoteRefs:47-75` misses `srcset/poster/@import url(//...)`. Replace with a parser-based sanitizer + tests for each bypass.
- `src/lib/templates/compileTemplateCss.ts:148-165` dual Tailwind (`tailwindcss:^3` + `tailwind4` alias, `package.json:93-94`), per-call `compile()`, `MEMO_LIMIT=24` evicts in-flight promises. Pin one compiler, LRU only settled entries.
- `src/lib/invoke.ts:7-23` logs every IPC `args` — leaks `data_url`/template bodies to the webview console. Redact like `diagnostics.ts:52-81`. Remove `console.log("[dbg]...")` in `src/lib/sync/sync.ts:137`.
- `src/pages/Designer.tsx:582-679` hydration N+1 (`ensureStarterTemplates` then `Promise.all(rows.map(list_versions))`). Batch it.
- `src/lib/share/client.ts:414-430` `fetchAllPages` unbounded `for(;;)`. Cap pages + support abort.

### Accessibility — P1 (README claims WCAG 2.1 AA)
- Toolbar buttons with emoji content and `title`-only (`src/components/ReadmeEditor.tsx:186-241`), unlinked `<Label>`/`<Input>` pairs (`src/pages/Print.tsx:977-986,1037`, `Designer.tsx:1363-1380`).
- `src/components/DataTable.tsx:102-115,246-262` row `tabIndex=0` + inner buttons that `stopPropagation` on click only — keyboard Enter double-fires; `History.tsx:386-390` swallows ArrowUp/Down.
- `src/components/designer/CanvasPane.tsx:41-47` `sandbox=""` + `pointer-events-none` preview has no text alternative; zoom `%` live region vs `custom` value mismatch (`CanvasWorkspace.tsx:108-143`).
- Fix: `aria-label`s, `htmlFor/id` links, keyboard-safe row activation, preview fallback text. Wire `axe-core` (already a devDep, `package.json:85`) into CI — currently never executed.

### State / error handling / perf — P1
- No persistence: `src/lib/store/printStore.ts:77-99` loses printer/template/copies on reload. Use `zustand/middleware persist` or URL params (`/print?template=&printer=`).
- Triple network timers (`useSyncStatus.ts:30-38`, `useShareStatus.ts:51-54` 120s poll, `scheduler.ts:220-229` 5min) hit the network independently. Consolidate.
- Empty `catch{}` in `History.tsx:75`, `Print.tsx:186,294`, `Templates.tsx:280`, `App.tsx:72,90,95,136`, `Layout.tsx:176` turn backend loss into empty lists. Surface + retry.
- `src/lib/sync/engine.ts:275-294,558-612` first non-409/428 error aborts the whole push queue — one bad row blocks everything. Collect per-row failures and continue.
- No `ErrorBoundary` (`src/App.tsx:22-28`, `src/main.tsx:27-35`): a `Handlebars.compile`/`bwip-js toSVG` throw outside `renderTemplate.ts:129-139` crashes the route.
- `CanvasPane.tsx:42` recompiles Handlebars on every keystroke/zoom/resize — memoize on `[html,css,data,compiledCss]`. `History.tsx:133-162` filters O(n) with no pagination/virtualization.

## 2. Server (`server/`) — P0 items first

### API — P0: body-limit mismatch blocks legal uploads
- `src/app.ts:31,55` `DEFAULT_BODY_LIMIT=16KiB`. Only `PUT /v2/templates/:id` overrides to 1MiB (`src/http/routes/templates.ts:56`). `PUT /v2/datasets/:id` allows 256KiB (`src/domain/datasets.ts:13`) and `PUT /v2/fonts/:id/file` allows 5MiB (`src/domain/fonts.ts:18`) with no override → framework 413 before domain validation.
- Fix: per-route `bodyLimit` matching each domain cap + tests for 300KiB dataset / 6MiB font.

### API — P0: health lies
- `src/http/routes/health.ts:9` returns `{status,version}` without a DB probe; `Dockerfile:66 HEALTHCHECK` + `docker-compose.yml:25` report healthy with dead Postgres.
- Fix: keep `/v2/health` cheap, add `/v2/ready` doing `SELECT 1`.

### API — P1: shadowing, status, fan-out
- `GET /v2/templates/mine` (`src/http/routes/templates.ts:221`) vs `GET /v2/templates/:id` (`:106`): `/mine` with `uuid` schema yields 400 instead of 404. Prefer `?scope=mine`, register static first, test.
- `204` mixes `z.null()` (`auth.ts:104`, `templates.ts:204`) vs `z.void()` (`library.ts:124`). Pick one (`void` + `send()`).
- `src/infra/prisma/sync.ts:39-90,265-268` 6× `take=limit+1` + in-memory merge + per-template `aggregate` in a loop. Push merge to SQL `UNION ALL` / cursor on `seq` + batch `groupBy`.
- `GET /v2/saved/manifest` (`src/http/routes/sync.ts:85`) has no pagination; move it to `savedRoutes` for cohesion.
- `POST /v2/templates/:id/use` (`:249`) lets any authed user bump any published template 1..100 with no dedup/rate cap. Add per-user/day cap.

### Auth — P0/P1
- No password change/rotation, no session list, no revoke-all, no delete-account; 30-day TTL (`src/config.ts:64`) makes a stolen token long-lived (`src/http/routes/auth.ts`, `src/domain/auth/session.ts`).
- `src/domain/auth/login.ts:25-31` skips `verify()` when user is null → timing oracle. Do a dummy verify on miss.
- `loginUser` mints a row per login, never caps per-user (`src/infra/prisma/sessions.ts`). Add `MAX_SESSIONS_PER_USER` + delete-oldest.
- Logout claims idempotent (`:101`) but missing/malformed token → 401 (`session.ts:31`). Decide `204 always` vs `401`.
- `ARGON2_*` only `positiveInt` (`src/config.ts:75-77`) — a `1GiB` env OOMs. Clamp (e.g. ≤256MiB, time ≤8).

### Validation — P0: UTF-16 vs bytes
- Schemas use `.max()` chars (`src/http/schemas/templates.ts:16`, `library.ts:9,28`, `account.ts:8`) but caps are bytes (`src/domain/templates/shared.ts:21`, `datasets.ts:42`). Multibyte names bypass limits. `version.label/note` (`schemas/templates.ts:43-49`) are unbounded → `TEXT` unlimited.
- Fix: `byteLength()` asserts everywhere; cap label/note (e.g. 200/2000).

### DB — P0/P1
- `Tombstone` has no user relation (`prisma/schema.prisma:57-67`); user delete cascades everything except tombstones → stale floor → `reset:true` storms. Add `user @relation(onDelete:Cascade)`.
- Missing `CHECK`s (`pageWMm>0`, `revision>=1`, `useCount>=0`, font format enum). Add in next migration.
- `FontFile.bytes BYTEA` (`schema.prisma:136-143`) stores ≤5MiB inline (TOAST bloat, full-Buffer loads in `src/infra/prisma/fonts.ts:76,147`). Move blobs to object storage, keep PG metadata.
- `bumpSeq` copy-pasted in 5 repos (`templates.ts:328-337`, `fonts.ts:40`, …), off-by-one (`create nextSeq:2n`). Extract `src/infra/prisma/seq.ts`, use `1n` + `increment`.
- `package.json:17` `db:migrate` = `prisma migrate dev` (creates migrations). Add `db:deploy` for prod; `client.ts:10` needs pool/statement timeouts.

### Observability / config / security — P1
- No metrics/tracing, 2xx not logged (`errorHandler.ts:84,100,112`), cleanup `setInterval` without `unref`/leader-election (`server.ts:68`), abrupt shutdown (`:82-93`, no drain timeout). Add `prom-client` counters, `unref()`, `Promise.race(10s)` + `prisma.$disconnect`.
- `server/.env` is committed with a password + LAN IPs (`server/.env:2-3`) — must stay gitignored; `env.example:10-18` documents only 3 vars while `docs/ENV.md` lists ~20 and compose wires ~8 (`docker-compose.yml:39-50`). Sync all three.
- `helmet({contentSecurityPolicy:false})` (`app.ts:80`) leaves `/docs` without CSP; `DOCS_ENABLED=true` by default (`config.ts:79`) exposes docs in prod. Default docs off in prod / internal port.
- Global limiter counts `/v2/health`+`/docs` (`app.ts:94-106`); no `Cache-Control: no-store` on `/v2/auth/*`, `/v2/sync/*`; no request timeout. Allow-list health, add no-store + `Vary: Authorization`, set `requestTimeout: 30s`.

## 3. Tauri / Rust (`src-tauri/`) — P0/P1

- Single `Mutex<Database>` (`db/mod.rs:60`) serializes every command + REST + worker; any panic while held poisons all future IPC (~30 `"DB lock poisoned"` sites). Scope locks narrowly (already partly done in `print.rs` / `api/routes.rs:519-599`), consider `parking_lot` + read/write split.
- `worker.rs:157-202` hot-spins `claim_next`, `recover_interrupted` marks clean-shutdown mid-print as `failed` with no resume; batch counters not recomputed after `delete_job` (`history.rs`), `delete_printer` (`printer.rs:141-152`) leaves `print_jobs.printer_id` dangling.
- Non-Windows `html_to_pdf/html_to_raster` always `Err` (`render/mod.rs:58-66,191-199`) — Linux CI/dev can never print. Gate print-path E2E behind the virtual printer or a PDF-stub feature.
- `transport/`: `windows_spooler.rs:119,137,199` raw `unsafe`; `WindowsUsbPrinter::new(name,0,0)` vid/pid zero (`mod.rs:199-201`); off-Windows `system/usb/bt` returns `None` with no CI. `status.rs:316-354` NAT-shared-IP silence map + 1h `Silent` cooldown undocumented.
- REST authZ (`api/routes.rs:74-150,172-237`): `allowed_ips` exact-string (no CIDR, IPv6 zone-id mismatch), idempotency fast-path returns before `last_used_at` audit, `list_jobs` caps 200 with no pagination, `batch_print` builds ≤5000 rows inside one `unchecked_transaction` (UI stall).
- `redact_with_secrets` (`commands/print.rs:907-955`) naive substring replace (4-char minimum still hits common words); `data/fetcher.rs:135-214` documents a DNS-rebinding gap; `deeplink.rs:26-69` accepts any post-`printninja://` path, unbounded `callback` (exfiltration), `copies` overflow silently defaults; `error.rs:1-17` serializes internal `Database/Internal` strings to IPC/REST.

## 4. E2E testing to add

### What exists (12 specs)
`e2e/tests/`: `smoke|auth|twoPc|conflict|versions|community|library|offline|sessionExpiry|printIsolation|adoption|reset.e2e.ts`. `printIsolation` explicitly never clicks print-submit; `fakeAgent/commands.ts:276-301` stubs `print_html/spike_test_print/list_jobs/get_job/reprint_job/retry_job/delete_job` and batch/API/deeplink commands as `warn+null`.

### Missing flows (new specs, in priority order)
1. **`print-submit.e2e.ts` (P0)** — real `print_html` via virtual printer: success row, failed row, timings visible, secret redaction in `rendered_html`, reprint/retry from History. Un-stub the 7 history commands; start `support/virtual-printer` from `stack.ts` (currently orphaned, ports in README `9100/515/631/8080` disagree with code `20100/11515/11631/11080` — fix one side).
2. **`batch.e2e.ts` (P0)** — create → queued → worker drain → progress → cancel → retry; asserts `claim_next` ordering, `update_batch_progress` counters, cancel resurrection guard. Needs `create_batch/list_batches/get_batch/cancel_batch/retry_batch` unstubbed.
3. **`local-api.e2e.ts` (P0)** — `start/stop/status/regenerate_key`, auth scopes (`read` vs `print`), IP allowlist, idempotency duplicate-job, `callback_url` 400, port-in-use error. Covers `api/routes.rs` + `commands/api.rs`, none of which run today.
4. **`printers.e2e.ts` (P1)** — add/test/delete, duplicate-name `COLLATE NOCASE`, invalid type/language/address, `get_printer` 404, `test_printer` success/failure messaging. Fake `add_printer` (`commands.ts:131-147`) currently ignores Rust validation (`printer.rs:67-138`) — mirror it or fail the spec.
5. **`deeplink.e2e.ts` (P1)** — `printninja://print/open/template`, confirm sheet, bad action, `copies=garbage`, `callback` handling. `parse_deeplink` is stubbed today.
6. **`designer-validation.e2e.ts` (P1)** — remote-ref rejection (`version.rs:103-108`), duplicate/empty name, Tailwind warnings, import/export round-trip. Testids `templateImport/classWarnings/designerSave` (`testids.ts:35,39-41`) exist but no spec uses them.
7. **`offline-library.e2e.ts` (P1)** — offline queue + replay for datasets/profiles/fonts/settings (today only a template version is replayed in `offline.e2e.ts`).
8. **`settings-admin.e2e.ts` (P2)** — onboarding 3-step (`UI_GUIDE.md:64-75`), brand/logo 256KB/type validation, density, diagnostics, trusted sources; API-tab `api_port` via UI (today set via raw `invoke`, `library.e2e.ts:338`).
9. **`negative-community.e2e.ts` (P2)** — save-conflict, withdrawn-template print attempt, empty search/sort states, Saved read-only enforced via direct `invoke` write attempt. Extends `community.e2e.ts` happy paths.
10. **`a11y-i18n.e2e.ts` (P2)** — Playwright `axe`, keyboard-only print flow, 390px/1440px viewports, `prefers-reduced-motion`, missing-key detection. `UI_GUIDE.md:410-436` requires these in Vitest only — nothing runs them in a browser.

### Harness fixes (do before adding specs)
- `support/stack.ts:39-111` one shared Postgres + one server for `fullyParallel` workers → cross-spec pollution (only `Date.now()` randomness). Isolate per-worker (schema per worker or serialized DB), use `randomUUID` run ids. Prod-parity flags are relaxed (`RATE_LIMIT_*=1000`, `DOCS_ENABLED=false`, minimal Argon2) — add a nightly prod-like run. `service.unref()` + `writeStackState` can orphan processes on `waitForHealth` failure.
- `playwright.config.ts:21-26` single Chromium, `reuseExistingServer:true` (stale 1420 bundle false-pass), `retries: CI?1:0`. Add Firefox/WebKit + mobile viewport projects, fail on reused stale server in CI, shard slow specs (`conflict/versions/community` 150–300s).
- `support/fixtures.ts:22-34` seed via `localStorage` with naive quote-escape — HTML with `'`/`</script>` breaks `addInitScript`. JSON-encode the seed. `signedInPc` handle collides under parallel (`Date.now()`); use `randomUUID`. One context = one PC; add multi-page same-PC helper for conflict races.
- `support/api.ts:1-181` covers only auth/mine/community/versions/sync. Add helpers for template PUT/publish/unpublish/saved-copy/datasets/profiles/fonts/settings so specs stop dropping to raw `fetch` (`adoption.e2e.ts:16-44`).
- `support/testids.ts:1-67` incomplete — specs hardcode `"conflict-banner"`, `"version-row-*"`, `"font-row-*"` (`conflict.e2e.ts:169`, `versions.e2e.ts:143`, `library.e2e.ts:228`). Enforce the registry (lint for literal `data-testid`), add History/Print/Printer/Designer-error/toast/dialog ids.
- `support/fakeAgent/*` reimplements Rust cache/sync/dirty logic in JS — any Rust fix without a JS mirror = green E2E + broken prod. Treat the fake as a contract: version it against Rust behavior, or run print/API/deeplink specs against the real agent only. Fix `seedPrinters` bundle-eval timing (`commands.ts:21`), `resetDatabase` counts (`cache.ts:768-781`), `.stack.json` + bundle artifacts in `support/`, and `stack-teardown.ts:30-31` hard `docker stop/rm` (breaks Podman/Testcontainers-Ryuk).
- `support/virtual-printer/` is fully built but never started by `stack.ts`, has no `package.json` script, and its README ports disagree with code. Wire it, document it, gate print specs on it.

### Server-side tests to add (Vitest, `server/test/`)
- Body-limit: 300KiB dataset → 413, 6MiB font → 413, 600KiB template → 413; `OPTIONS` CORS preflight per origin; `helmet` headers; `x-request-id` on 500 (today only 404/400 in `plugins.test.ts`).
- Concurrency: parallel `PUT` same id+revision → one 409; parallel register same handle (exists for auth, `integration/auth.test.ts:230` — extend to templates/datasets/fonts); `incrementUseCount` lost-update check.
- Sync: `reset:true` when cursor < tombstone floor, `types=` unknown → 400, `since=` garbage → 400, byte-budget trim + `has_more`/`next_cursor` monotonicity, empty-page invariant, query-count regression for the N+1 in `sync.ts`.
- Docs gating: `/openapi.json` → 404 when disabled (only `/docs` asserted, `plugins.test.ts:230`).
- Retention: `purgeOldTombstones` boundary (91d purged, 89d kept at 90d retention) — today only sessions are tested.
- Pipeline: `typecheck + arch (dependency-cruiser) + openapi:check (git diff --exit-code) + test:unit + test:int` with coverage threshold (fail <80% on `domain/`).

## 5. Suggested order

1. P0 correctness: print payload (pageRange/grayscale), preview data, designer dirty-guard, server body limits, health/ready, byte validation, tombstone FK, login timing oracle.
2. P0 E2E: `print-submit`, `batch`, `local-api` behind the virtual printer; per-worker DB isolation first or the new specs will flake.
3. P1 UX/debt: CSV parser, batch progress, Saved N+1, search debounce, printer edit flow, retention (implement or remove), sanitizer replacement, store cleanup, IPC redaction.
4. P2 hardening: sessions lifecycle, metrics/tracing, font blob storage, CHECK constraints, a11y/i18n E2E, docs-off-by-default.
