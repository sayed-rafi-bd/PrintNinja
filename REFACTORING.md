# PrintNinja Backend Redesign: Design and Implementation Plan

Oct 20, 2026 · @Rafi · Revision 2: the server is the source of truth and the app is a cache; the service lives in `server/`; Playwright end-to-end tests added. All sign-offs approved and all 24 questions answered on 2026-10-20 (sections 1 and 13).

## 1. Summary

Keep printing on the user's machine. Make a new TypeScript service (Fastify, Prisma, PostgreSQL) the **source of truth** for everything a user owns: templates, version history, sample datasets, printer profiles, fonts and account preferences. The Rust app becomes a **cache that prints from its local copy**. The service lives in the `server/` directory of this repository and replaces the Rust share server, which moves to `server-legacy/` until cutover. A server cannot print for this app: it needs the Windows spooler, headless Edge, USB, Bluetooth and printers on the user's own network. The hosted service therefore stays out of the print path, and printing never waits on the network.

**What exists.** A Tauri 2 desktop and Android app: a React UI, a Rust core with a local SQLite database (11 tables, 48 IPC commands), a local REST API on `127.0.0.1:17717` (10 operations), and a separate Rust share server (13 operations, 4 tables). I read the `develop` snapshot supplied as `PrintNinja-develop.zip` (commit `92433da`).

**Most important finding.** The bugs that hurt users most are in the Rust print path, not in the share server, so a new backend does not fix them. Verified in code: History reprint and retry fail on invalid SQL, batch and reprint only write `queued` rows that nothing prints, and the printer's command language (ESC/POS, ZPL, TSPL) is never applied. Phase 0 fixes these in Rust before the backend work starts.

**Recommended stack.** Fastify 5 with Zod schemas that generate OpenAPI, then a typed TypeScript client for the frontend. Prisma on PostgreSQL behind repository interfaces. Vitest with Testcontainers for the backend, Playwright for the frontend. No DI container, no microservices.

### What changed in this revision

1. **The template cache is a real cache.** The server owns templates. The app asks "what changed since I last synced?" through one delta endpoint, `GET /v2/sync/changes?since=<cursor>`, which returns changed and deleted records. Every record carries a server `revision`, and updates are checked against it. The app refreshes in the background at startup, on focus and on a timer, and never at print time (section 6).
2. **More data moves to the server.** Version history moves from Phase 4 to Phase 2 (backend) and Phase 3 (app). Printer profiles, sample datasets, non-device settings and fonts follow in Phase 4, stored on the server and cached locally.
3. **What stays local** is the hardware side: printers, transports, the queue and print worker, the local API server with its keys, and deep links. Local API keys are secrets for the local server and never leave the machine.
4. **Same repository.** The service is in `server/`, the Rust share server moves to `server-legacy/`, and one pnpm workspace holds the app, the service and the end-to-end suite (section 5).
5. **Frontend end-to-end tests** with Playwright, selecting elements by `data-testid`. Printing is not covered by end-to-end tests because it cannot be driven from a browser (section 11).

**Sign-offs: all seven approved on 2026-10-20**

1. Hardware boundary: printers, transports, the queue, batches, job history, the local API and deep links stay in the local Rust agent. Everything the user owns moves to the server and is cached locally (section 6). — **approved**
2. PostgreSQL for dev, CI and production instead of staying on SQLite (section 4). — **approved**
3. A new `/v2` contract with new error and pagination shapes instead of keeping `/v1` (section 9). — **approved**
4. Phase 0: fix the Rust print-path bugs first (section 12). — **approved**
5. Print history sync to the cloud: **deferred** — out of scope for now; it remains an optional, undesigned Phase 5 (section 13, question 10).
6. The server is the source of truth, with a delta sync endpoint and mandatory revisions (sections 6 and 8). — **approved**
7. The Playwright suite and a fake desktop agent for it (section 11). — **approved**

All 24 questions are answered in section 13, so nothing is left open before the Phase 1 spike.

## 2. Existing architecture

PrintNinja is a local-first desktop and Android app with a small hosted side service: every printing step already runs on the device, and only template sharing touches a server.

| Component | Technology | Responsibility |
| --- | --- | --- |
| UI (`src/`) | React 18, Vite 6, Zustand, TanStack Query and Table, Tailwind 3 | Designer, Templates, Print, Printers, History, Settings. Compiles per-template Tailwind CSS and renders previews in sandboxed iframes. |
| Rust core (`src-tauri/`) | Tauri 2, rusqlite, axum, reqwest, handlebars | 48 IPC commands, print pipeline, per-printer queue, transports, local REST API, deep links. |
| Local database | SQLite `printninja.db` via rusqlite | 11 tables: printers, templates, versions, jobs, batches, API keys, settings. |
| Local REST API | axum on `127.0.0.1:17717`, off by default | Automation: print, batch, jobs. Bearer key `pn_live_...`. |
| Share server (`server/`) | axum, rusqlite, scrypt | Accounts, sessions, private and published templates, saved list, use counts. |
| Android plugin | Kotlin | WebView to PDF, USB, Bluetooth, mDNS. The Rust bridge `android_bridge.rs` is a stub that returns no printers. |

In this plan the Rust share server moves from `server/` to `server-legacy/` in Phase 1, and the new TypeScript service takes the `server/` directory (section 5).

### How printing works today

One pipeline, `run_print` in `commands/print.rs`, serves the UI, the REST API and test prints.

1. Resolve the template version (pinned or current) and page size from SQLite.
2. Fetch JSON from `data_url` if given (15 s timeout, 5 MB cap).
3. Render Handlebars with six helpers: currency, date, upper, lower, padLeft, number.
4. Inject `@page` size, margins, fit mode and print-colour rules.
5. Convert to PDF with headless Edge (Windows only).
6. Take the per-printer semaphore and send each copy through the transport for the printer type.
7. Insert a `print_jobs` row with the rendered HTML, secrets redacted.

### Business rules to preserve

- **Templates:** remote references are rejected (use `data:` URIs). Caps: 512 KiB HTML, 256 KiB CSS, 64 KiB README. A new template gets version 1. Rust accepts version authors `manual`, `autosave`, `restore` and `sync`.
- **Sharing:** the client generates the UUID and `PUT` is idempotent. Only the owner can update or delete (403). Private templates return 404 to everyone else. Saved copies are read-only locally. Printing a saved copy increments `use_count`. An unpublished template shows as withdrawn to people who saved it.
- **Accounts:** handle of 1 to 32 characters from `A-Z a-z 0-9 _ -`, unique ignoring case; password of at least 8 characters; opaque 32-byte token stored as SHA-256; 30-day sessions; 5 attempts per minute per handle and per IP.
- **Local API:** `Idempotency-Key` replay guard; one job at a time per printer; batches of up to 5,000 records in `per_record` or `single_job` mode.
- **Deep links:** `printninja://print`, `open/...`, `template/...`; a confirmation sheet unless the source is trusted.

### Data models

**Local SQLite:** `printers`, `templates`, `template_versions`, `sample_datasets`, `fonts`, `printer_profiles`, `presets`, `batches`, `print_jobs`, `api_clients`, `settings`. No Rust code reads or writes `sample_datasets` or `presets`.

**Share server SQLite:** `users`, `sessions`, `templates`, `saved_templates`. Its `templates` row holds `body`, `css`, `readme`, page size, `use_count`, and a `published_at` that is the empty string when the template is private.

### Which operations need the local machine

| Operation | Why it cannot move to a server | Code |
| --- | --- | --- |
| HTML to PDF | Runs `msedge.exe --print-to-pdf` on the PC | `render/mod.rs` |
| System printers, spooler send | Win32 spooler calls with the RAW datatype | `transport/windows_spooler.rs` |
| USB and Bluetooth | Local device access; the USB transport is built with vendor and product id 0 | `windows_usb.rs`, `windows_bluetooth.rs`, `transport/mod.rs` |
| IPP and raw TCP 9100 | Printers on the user's private network | `ipp.rs`, `raw_tcp.rs` |
| One job at a time per printer | Protects a single physical print head | `queue.rs` |
| Fonts, at render time | Edge reads the font file from the PC's disk. A cached copy is enough, so the bytes themselves can be stored on the server | `commands/font.rs` |
| Deep links, local REST API | An OS URL handler and a socket on the PC | `deeplink.rs`, `api/` |

Everything else (accounts, template storage, versions, community sharing) has no hardware dependency and can live in a hosted service. With a local cache in front of it, so can printer profiles, sample datasets, font files and account preferences (section 6).

## 3. Verified bugs and technical debt

Eighteen defects, ranked by user impact. Ten are critical or high and sit in the Rust app, which a TypeScript backend does not touch, so they are scheduled as Phase 0. I confirmed each by reading the code; P1 I also reproduced in SQLite.

| # | Severity | Where | What happens | Fix in |
| --- | --- | --- | --- | --- |
| P1 | Critical | `commands/history.rs:50, 65, 88, 115, 133` | `SELECT_JOB_COLUMNS` ends in `ORDER BY id DESC`. `get_job`, `reprint_job` and `retry_job` append `WHERE id = ?1`, a SQL syntax error. No test calls these commands. | Phase 0 |
| P2 | Critical | `commands/version.rs:46`, `db/schema.sql:36`, `share/sync.ts:130` | Refresh from server sends `created_by: "sync"`. Rust accepts it, but the table `CHECK` allows only `manual`, `autosave`, `restore`, so the insert should fail. Read from code, not run. | Phase 0. After Phase 3 the cause is gone: pulling a server copy no longer writes a `sync` version |
| P3 | Critical | `history.rs`, `batch.rs`, `api/routes.rs` | Reprint, retry, batch and `POST /v1/print/batch` insert `queued` rows that nothing consumes; `lib.rs:87` only logs the queue channel. Batch `done` and `failed` never change and no code sets `printing`. This is the same failure as the fake `202` already fixed in `POST /v1/print`. `POST /v1/print/batch` also drops each record's data in `per_record` mode (only the index is stored) and has no 5,000-record cap; that cap exists only in the IPC `create_batch`. | Phase 0 |
| P4 | Critical | `commands/print.rs:244-450` | `printers.language` is never read. Every job is sent as PDF bytes, including to raw TCP and USB thermal printers. The ESC/POS, TSPL and ZPL encoders and `render/raster.rs` are not called by the pipeline. | Phase 0, needs hardware |
| P5 | Critical | `render/mod.rs:23, 117` | If Edge is missing or fails, or on any non-Windows platform, a stub PDF containing the word "PrintNinja" is sent and reported as success. | Phase 0 |
| P6 | High | `render/mod.rs:23` | Every render writes `render.html` in one cache folder. Jobs for different printers run in parallel, so one job can render another's HTML. | Phase 0 |
| P7 | High | `transport/ipp.rs:43` | Success means HTTP 2xx only. The IPP status code in the response body is never read, so a rejected job counts as printed. The URL is fixed to `http://host:631/ipp/print`. | Phase 0 |
| P8 | Medium | `commands/print.rs:383`, `queue.rs` | The queue key is the printer name as typed, but lookups ignore case, so `Desk` and `desk` get separate locks. `queue.submit` feeds a channel that only logs. | Phase 0 |
| P9 | High | `server/src/main.rs`, `auth.rs` | One global mutex guards the only database connection and scrypt runs while it is held, so one login stalls every request. The throttle trusts `X-Forwarded-For` and never evicts keys. CORS is permissive, the port binds `0.0.0.0` over plain HTTP, and sessions are never purged. | Backend, Phase 1 |
| P10 | High | `server/src/main.rs:446` | The remote-reference check on publish tests four patterns. The client check in `render/handlebars.rs` also covers single quotes, unquoted `url()`, `//` and `@import`. Published HTML is stored and served unsanitised. | Backend, Phase 2 |
| P11 | High | `db/mod.rs` | `connection()` opens a new SQLite connection on every call; the `Mutex` guards only the URL string. No WAL, no busy timeout. Three schema paths exist: `schema.sql`, `ensure_v2_schema` and a plugin migration. | Phase 0 |
| P12 | High | `api/routes.rs`, `commands/api.rs` | API-key `scopes`, `allowed_ips` and `last_used_at` are stored but never checked. The idempotency check runs before the job row exists, so two concurrent requests both print. `callback_url` is accepted and ignored. The hand-written `openapi.rs` says `data` is required; the code treats it as optional. | Phase 0 |
| P13 | High | `data/fetcher.rs`, `deeplink.rs` | `data_url` fetches any URL and follows 5 redirects with no scheme or address limits, so a caller can reach `localhost` or LAN hosts. | Phase 0 |
| P14 | Medium | `commands/print.rs:318-321` | Handlebars is skipped when no data is given, and errors are swallowed with `unwrap_or(html)`, so the raw template source can be printed instead of the rendered label. | Phase 0, pick one engine |
| P15 | Medium | `commands/print.rs:522` | The job row is written after printing ends: `started_at` equals `finished_at`, `job_id` is empty on a render failure, and a running job is invisible. | Phase 0 |
| P16 | Medium | `server/src/main.rs`, `share/client.ts` | Timestamps mix `YYYY-MM-DD HH:MM:SS` with no zone and RFC 3339; the client compares them with `new Date()`, which reads the first as local time. Private templates use `''` instead of null. A duplicate handle returns 400, not 409. LIKE wildcards in search are not escaped. The list returns a bare array with no total. A first `PUT` without a `publish` flag publishes the template (`main.rs:480`), and a later `PUT` without `readme` or `summary` resets them to empty while `css` is kept (`main.rs:440, 475`). | Backend, Phases 1 and 2 |
| P17 | Low | README, `package.json` | The README says secrets live in `keyring`; there is no such dependency and the session token is plain text in `settings`. `retention_days` has no Rust code behind it. `server/Cargo.toml` says Turso-backed but uses SQLite, and `server/Caddyfile` refers to a compose profile `https` that `docker-compose.yml` does not define. `server/dockerignore` has no leading dot, so Docker never reads it as `.dockerignore`. The app's manifests all agree on 0.5.0. | Docs |
| P18 | Low | `src/` | Entity types are copied by hand in several files (`Template` in `templateStore.ts` and `sync.ts`, job and printer shapes in each page), `invoke<any>` appears in the Designer, and IPC command names are plain strings. | Frontend, Phase 3 |

Dead code worth deleting: `RateLimiter`, `ApiKey::check_scope`, `db_for_auth`, and the tables `sample_datasets` and `presets`.

**Not verified.** How real printers react to a RAW spooler job holding PDF bytes, the USB transport built with ids 0, and the Android path. These need hardware.

**Sound and worth keeping.** Opaque session tokens stored as hashes, 404 for other people's private templates, idempotent `PUT` with a client UUID, constant-time key comparison, and the per-printer permit design in `queue.rs`.

## 4. Technology choice

Use Fastify 5. It is the smallest option that gives validated routes, generated OpenAPI and easy testing on Node, which is where Prisma runs best.

|  | Fastify | Hono | NestJS |
| --- | --- | --- | --- |
| Runs on | Node | Node, Bun, Deno, edge | Node |
| Contract from code | `@fastify/swagger` with a Zod type provider | `@hono/zod-openapi`, very direct | `@nestjs/swagger` with decorators on DTO classes |
| Validation | Zod schema per route | Zod or Valibot | class-validator classes |
| Tests without a port | `app.inject()` | `app.request()` | Testing module plus supertest |
| Abstraction cost | Plugins and hooks | Smallest | Modules, providers, decorators, DI container |
| Fit here | Good: a Node API with a relational database | Good, but its edge strength goes unused and Prisma needs driver adapters on edge runtimes | Over-built for about 15 endpoints |

Hono is a reasonable second choice if you want the smallest framework. NestJS is rejected because the brief asks for no unnecessary abstractions.

### Recommended stack

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime | Node 22 LTS, 22.22 or newer | The app's CI already uses Node 22; Testcontainers 12 declares `>= 22.22` |
| Language | TypeScript 5.x, `strict` | Same major as the app (`~5.6`). npm `latest` is already 7.0.2; the Phase 1 spike decides whether to start on it (tool compatibility not checked) |
| HTTP | Fastify 5 | See above |
| Validation and contract | Zod 4 with `fastify-type-provider-zod` 7 | One schema validates input and produces OpenAPI. The provider needs Zod >= 4.1.5. The app is on Zod 3, which does not matter: the repositories share an OpenAPI file, not Zod schemas |
| API docs | `@fastify/swagger`, `@fastify/swagger-ui` | Swagger UI at `/docs`, JSON at `/openapi.json` |
| Database | PostgreSQL 16 | Concurrent writers, real timestamps, case-insensitive uniqueness |
| ORM and migrations | Prisma 7.10.x with `@prisma/adapter-pg` and `pg` | Typed client, migration files, schema as the data-model source. Prisma 7 requires a driver adapter, a `prisma.config.ts` and an explicit client output path. npm `latest` is currently an 8.0 release candidate, so pin 7.x |
| Passwords | argon2id, with scrypt verification for migrated users | See section 13 |
| Security plugins | `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit` | Replace permissive CORS and the spoofable throttle |
| Logging | pino, built into Fastify | JSON logs with request ids |
| Tests | Vitest 5, Testcontainers 12 (PostgreSQL) | See section 11 |
| Lint and format | Biome | The frontend already uses it |
| Package manager | pnpm 10, one workspace with the app | Same tool as the app; one lockfile |
| Packaging | Docker image (`server/Dockerfile`), root `docker-compose.yml` with PostgreSQL | Replaces the Rust Dockerfile, which moves to `server-legacy/` |
| Frontend client | `openapi-typescript`, `openapi-fetch` | See section 10 |
| Frontend end to end | Playwright (Chromium), esbuild for the fake agent | See section 11 |

Versions below were read from the npm registry on 2026-10-20; nothing was installed.

| Package | Current | Constraint found |
| --- | --- | --- |
| `fastify` | 5.12.7 | Type provider needs `^5.5.0` |
| `fastify-type-provider-zod` | 7.0.0 | Needs `zod >= 4.1.5` and `@fastify/swagger >= 9.5.1` |
| `@fastify/swagger` | 9.9.2 | Satisfies the provider |
| `zod` | 4.6.7 | The app uses 3.x |
| `@prisma/client` | 7.10.1 | Needs Node 20.19+, 22.12+ or 24+, and TypeScript 5.4+ |
| `prisma` | `latest` is 8.0.0-rc.23; 7.10.1 is the previous release | Pin 7.x |
| `vitest` | 5.0.5 | Node 22.12+ |
| `testcontainers` | 12.2.1 | Node 22.22+ |
| `@playwright/test` | not checked | Downloads a browser; must be on the pnpm build allow-list (section 5) |

Not verified: that these packages together emit a valid, complete OpenAPI 3.1 document, and that `argon2` has a prebuilt binary for the Docker base image. Both are Phase 1 spike items (section 12).

### PostgreSQL instead of SQLite

The current share server uses one SQLite file. I recommend PostgreSQL because the new service will have concurrent writers, needs timestamps with a time zone, and needs case-insensitive unique handles. A Prisma schema has one provider, so development, CI and production should all use PostgreSQL. Independence from the database comes from the repository interfaces in section 5, not from switching providers.

The cost is one more container. If single-file self-hosting matters more than concurrency, Prisma on SQLite also works; only `infra/prisma` and the handle-uniqueness migration change.

## 5. Repository structure

The new service goes into the existing repository, in `server/`. The Rust share server that lives there today moves to `server-legacy/` with `git mv` at the start of Phase 1, so history is kept and the old code stays buildable during the cutover window. It is deleted in Phase 3. The end-to-end suite lives in `e2e/` at the repository root because it drives both the app and the service.

```text
PrintNinja/                       the existing repository
  pnpm-workspace.yaml             adds packages: server, e2e (the app stays the workspace root)
  docker-compose.yml              new: server + PostgreSQL (the old Rust compose file moves to server-legacy/)
  env.example                     updated for the new variables (section 12)
  src/  src-tauri/                the app, layout unchanged
  server-legacy/                  the current Rust share server; deleted at cutover (Phase 3)
  server/                         the new TypeScript service, three layers
    package.json  tsconfig.json
    prisma.config.ts              Prisma 7 CLI config: schema path, migrations path, DATABASE_URL
    prisma/
      schema.prisma
      migrations/
    src/
      server.ts                   process entry: load config, build app, listen, shut down cleanly
      app.ts                      buildApp(deps): registers plugins and routes; tests call it too
      config.ts                   Zod-validated environment
      http/                       layer 1: transport only
        plugins/                  auth, error handler, rate limit, request id, openapi
        routes/                   auth, templates, versions, community, saved, sync, datasets,
                                  profiles, settings, fonts, health
        schemas/                  Zod schemas: the API contract
        mappers.ts                domain object to response shape
      domain/                     layer 2: business rules, no Fastify, no Prisma
        auth/                     register, login, logout, session check
        templates/                rules (caps, remote refs, visibility, revisions) and service
        versions/                 history, restore, autosave pruning
        sync/                     change sequence, delta reads, tombstones
        community/                list, saved, saved manifest, use counter
        library/                  datasets, profiles, settings allow-list, fonts
        errors.ts                 DomainError subclasses
        ports.ts                  interfaces for repositories, clock, ids, hasher, font store
      infra/                      layer 3: implements the ports
        prisma/                   client, one repository per aggregate, generated/ (git-ignored Prisma client)
        security/                 password hasher, token generator
        fonts/                    FontStore: font bytes in PostgreSQL today, replaceable by disk or S3
    test/
      fakes/                      in-memory repositories for unit tests
      factories/                  test data builders
      integration/                routes against a real PostgreSQL
      e2e/                        API workflows against a running container
    openapi/openapi.json          generated and committed
    scripts/import-v1.ts          one-off import from the Rust server's SQLite file
    Dockerfile  .dockerignore  .env.example
  e2e/                            Playwright suite for the app (section 11)
    package.json  playwright.config.ts
    support/                      testids.ts, fake agent, API helper, stack setup, fixtures
    tests/                        one file per workflow, named *.e2e.ts
```

### Changes to files outside `server/` and `e2e/`

| File | Change | Why |
| --- | --- | --- |
| `pnpm-workspace.yaml` | Add `packages: [server, e2e]`. Add the packages that need install scripts (`argon2`, `prisma`, `@prisma/engines`, Playwright's browser download) to the build allow-list | pnpm 10 skips install scripts unless allowed. The existing file allows only `esbuild`. Exact names are confirmed in the Phase 1 spike |
| `vitest.config.ts` | Add `server/**` and `e2e/**` to `exclude` | Vitest's default include pattern would pick up `*.test.ts` in `server/` and any `*.spec.ts` in `e2e/` and run them under jsdom |
| `biome.json` and the `lint` script | Include `server/src`, `server/test`, `e2e` | The frontend already lints with Biome; one tool for all three packages |
| `tsconfig.json` | No change | It includes only `src`, so `tsc -b` never sees `server/` or `e2e/`; each has its own `tsconfig.json` |
| `.github/workflows/ci.yml` | Point the Rust share-server test job at `server-legacy/`; add the server jobs and the app e2e job (section 11) | |
| `docker-compose.yml`, `env.example` | Replace with the new service and PostgreSQL | The current ones build the Rust image from `./server` |
| `.gitignore` | Add `server/dist` and `server/src/infra/prisma/generated` | `playwright-report` and `test-results` are already ignored |
| `README.md`, `CHANGELOG.md` | Update paths and the share-service section | P17 |

### Layer rules

- `http` imports `domain`. `domain` imports neither `http` nor `infra`. `infra` imports only types and ports from `domain`.
- Services take their repositories as constructor arguments and are wired by hand in `app.ts`. No DI container.
- The Zod schemas in `http/schemas` are the single contract. Domain types are plain TypeScript interfaces.
- Prisma types never leave `infra`; repositories return domain objects.
- The domain throws typed `DomainError`s. One error handler in `http/plugins` maps them to status codes and the error envelope (section 9).
- A transaction is a repository method, for example `register` creates the user and first session together, and every synced write bumps the user's change sequence in the same transaction (section 7). There is no generic unit of work.
- `server/` shares no code with the app. The only link between them is `server/openapi/openapi.json`, which the app turns into types (section 10).

### Module responsibilities

| Module | Owns | Must not |
| --- | --- | --- |
| `http/routes` | URL, method, schema binding, status code, auth guard | Contain rules or queries |
| `http/schemas` | Request and response Zod schemas, OpenAPI text | Import domain services |
| `domain` services | Rules: size caps, visibility, ownership, revisions, use count, quotas, settings allow-list | Know about HTTP or Prisma |
| `domain/ports.ts` | `UserRepository`, `SessionRepository`, `TemplateRepository`, `VersionRepository`, `SavedRepository`, `SyncRepository`, `LibraryRepository`, `FontStore`, `Clock`, `IdGenerator`, `PasswordHasher` | Expose Prisma types |
| `infra/prisma` | Queries, transactions, translating a unique violation into a domain conflict | Contain business rules |
| `test/fakes` | In-memory implementation of every port | Be imported by production code |

Prisma gives the typed client and migrations. The repository interface is the seam that lets services run against in-memory fakes in unit tests, and lets the database change without touching a rule. Documentation only, not code to commit:

```ts
interface TemplateRepository {
  findById(id: string): Promise<Template | null>;
  // One transaction: check if_revision, write the row, append a version, take the next
  // change sequence for the owner. Throws RevisionConflict when the stored revision differs.
  upsert(input: TemplateWrite, expected: { ifRevision: number | null }): Promise<Template>;
  delete(id: string): Promise<void>;                    // also writes the tombstone
  listPublished(q: ListPublishedQuery): Promise<Page<TemplateSummary>>;
  listByOwner(ownerId: string, q: PageQuery): Promise<Page<TemplateSummary>>;
  incrementUseCount(id: string, by: number): Promise<void>;   // one atomic UPDATE
}

interface SyncRepository {
  // Records and tombstones of one user with changeSeq > cursor, in sequence order.
  readSince(userId: string, cursor: bigint, limit: number, byteBudget: number): Promise<ChangePage>;
  tombstoneFloor(userId: string): Promise<bigint>;      // oldest cursor still answerable
}
```

## 6. Frontend, backend and local cache

The UI talks to two backends: the local agent over Tauri IPC, and the hosted API over HTTPS. The split is now by **who owns the data**, not by which screen shows it.

- **The hosted API owns what the user creates:** templates, their version history, sample datasets, printer profiles, fonts and account preferences.
- **The local agent owns the hardware and the print job:** printers, transports, the queue and print worker, jobs and batches, the local REST API and its keys, deep links. It also holds the **cache** of everything the server owns, and it prints from that cache.

Printing never calls the hosted API, so it keeps working with the network off.

### Who owns what

| Data | Source of truth | Local copy | Notes |
| --- | --- | --- | --- |
| Own templates (HTML, CSS, README, page size) | Server | Cache row with `server_revision` | Edits are written locally first, then pushed |
| Saved community templates | The author's server copy | Read-only cache row | Kept fresh through the saved manifest (section 8) |
| Template versions | Server | The latest 20 per template, filled on demand | List, read, restore and delete go to the server |
| Sample datasets | Server | Cache | No UI or Rust command persists them today; the Designer panel for them is a Phase 4 deliverable |
| Printer profiles | Server, keyed by template and printer name | Cache | A profile for a printer name this PC does not have stays dormant |
| Fonts | Server (bytes and metadata) | Metadata, plus the file on disk once downloaded | Edge needs the file on disk to render |
| Account preferences: `ui_density`, `brand_name`, `brand_logo` | Server | Cache | The full key list is audited in Phase 4 (question 23, answered: everything not on the allow-list stays local) |
| Printers and their addresses | **Local only** | n/a | A printer is a device attached to this PC or its network |
| Transports, print queue, print worker | **Local only** | n/a | |
| Jobs, batches, job history | **Local only** | n/a | Optional cloud sync is Phase 5 |
| Local API server, `api_port`, `api_lan_access`, API keys | **Local only** | n/a | API keys are secrets for the local server and never leave the machine |
| Deep links and `trusted_sources` | **Local only** | n/a | Trust is a per-device security decision |
| Device settings: `retention_days`, `onboarding_done`, `share_service_url`, `share_session_token` | **Local only** | n/a | The session token is still plain text in `settings` (P17, question 16) |

### How the cache works

1. **Reads never leave the machine.** The Designer, the Templates list, the Print page and the print pipeline read the local cache over IPC. The hosted API is called by the sync engine, and directly only for things that need the network by nature: community browsing, save and unsave, publish and unpublish, and the account calls.
2. **Writes go to the cache first.** Editing a template writes the local row, marks it `dirty` and returns at once. The sync engine pushes dirty rows in the background. Deleting a template leaves a local tombstone row until the server confirms.
3. **Pull uses the delta endpoint.** The app stores a `cursor` per account. `GET /v2/sync/changes?since=<cursor>` returns the records that changed and the ids that were deleted after that point, plus the next cursor. The app applies one page and saves the new cursor in the same local transaction, so a crash in the middle repeats a page instead of skipping it. First run is `since` empty, which returns everything.
4. **Revisions guard every update.** Each synced record has a server `revision` that starts at 1 and rises by one on every content change (publishing or unpublishing does not change it). A push sends the revision the edit was based on (`if_revision`). The server refuses an out-of-date push with `409 revision_conflict`, so one PC never silently overwrites another.
5. **When the sync engine runs:** at startup after the sign-in gate, when the window regains focus (at most once a minute), every 5 minutes while the app is open, 3 seconds after a local edit (push only), and when the browser `online` event fires. **Never at print time:** the print pipeline does not wait for, start or retry a sync.
6. **Print-count events are queued, not sent.** Printing a saved community copy used to call `POST .../use`. Now the print worker increments a local counter after the job ends, and the sync engine sends it later with `POST /v2/templates/{id}/use` and a `count`. A failed send is retried; printing is never delayed or blocked by it.
7. **The cursor can be too old.** The server keeps tombstones for 90 days. A cursor older than that gets `reset: true`, and the app does a full pass from the start, then removes any `synced` cache row it did not see.
8. **The cache belongs to one account.** `sync_state` stores the account id and server URL. Signing in as someone else, or against another server, clears the cache first and warns if dirty rows would be lost.
9. **Staleness is visible.** A status chip in the app shell shows one of: `synced` (with the time of the last successful pull), `syncing`, `pending` (n local changes not pushed), `offline` (last pull failed or no network), `conflict`. It also shows how old the data is, which is the staleness badge the earlier design deferred.

### Conflicts

A conflict is a push the server refuses with `409 revision_conflict`. The row becomes `conflict` and the Designer opens a dialog with three choices:

| Choice | Result |
| --- | --- |
| Keep mine | Re-push the local content against the server's current revision. The server revision moves past the other PC's edit, which stays in version history |
| Take server | Discard the local edit and apply the server copy |
| Keep both | Save the local content as a new template (new UUID), then take the server copy for the original |

Version history makes "Keep mine" safe: the overwritten revision is still there. A push that was applied but whose response was lost is not a conflict: the server recognises identical content and answers `200` with the stored revision (section 8).

### Starting without the server

With a cache and a stored session, the app opens in **offline mode** when the server cannot be reached at launch: templates, printers and printing all work, the status chip says `offline`, and the sync engine retries in the background. Without a cache, the "cannot reach server" screen stays, because there is nothing to work with. A `401` from the server still sends the person to sign-in, and unsaved edits stay in the cache while the sign-in screen is shown.

### Where the sync engine runs

In the frontend (`src/lib/sync/`), written against the generated client. The Rust side gets a few transactional cache commands (below) and stays free of HTTP code for this purpose. The cost: if the local REST API is used with no window open, it prints the cache as of the last sync. Moving the engine into Rust, which already has `reqwest`, is the answer if headless use matters (question 22, answered: frontend first).

### What happens to the 48 IPC commands

| Group | Commands | Disposition |
| --- | --- | --- |
| Printers | `list_printers`, `add_printer`, `delete_printer`, `get_printer`, `test_printer`, `enumerate_system_printers` | Stay local |
| Printing | `print_html`, `spike_test_print` | Stay local; read the cache only |
| History | `list_jobs`, `get_job`, `reprint_job`, `retry_job`, `delete_job` | Stay local; optional cloud sync in Phase 5 |
| Batches | `create_batch`, `list_batches`, `get_batch`, `cancel_batch`, `retry_batch` | Stay local |
| Local API | `start_api_server`, `stop_api_server`, `get_api_status`, `regenerate_api_key` | Stay local |
| Settings and links | `get_setting`, `set_setting`, `get_trusted_sources`, `set_trusted_sources`, `parse_deeplink`, `ping` | Stay local, for device settings only. Account preferences go through the cache (Phase 4) |
| Templates | `list_templates`, `create_template`, `get_template`, `update_readme`, `update_template_meta`, `delete_template` | Stay, but become cache writes: they mark the row `dirty` (or tombstone it) |
| Templates, sync bookkeeping | `set_publish_info`, `clear_publish_info`, `update_template_origin` | Retired in Phase 3. The sync engine writes `server_id`, `server_revision`, visibility and `kind` (own or saved) through the cache commands |
| Versions | `list_versions`, `create_version`, `delete_version`, `restore_version`, `diff_versions` | The UI reads and writes versions through the hosted API. The local table keeps only the latest 20 per template as a read cache, so `diff_versions` works offline on cached versions |
| Profiles and fonts | `list_profiles`, `save_profile`, `delete_profile`, `list_fonts`, `upload_font`, `delete_font` | Cache reads and writes from Phase 4; `upload_font` becomes "write the file to the cache folder, then upload" |

**New cache commands (proposal).** `cache_get_sync_state`, `cache_apply_changes` (one transaction: records, deletions and the new cursor), `cache_list_dirty`, `cache_mark_pushed`, `cache_mark_conflict`, `cache_resolve_conflict`, `cache_queue_use`, `cache_clear_account`, and in Phase 4 `cache_put_font_file`. The final count is fixed in Phase 3.

**Local schema changes (Phase 3).** `templates` gains `server_id` (a UUID the client generates at creation, as it does today; replaces `remote_id`), `server_revision`, `base_revision`, `sync_state` (`synced`, `dirty`, `deleted_pending`, `conflict`), `kind` (`own` or `saved`), `owner_handle`, `synced_at`. New table `sync_state` (account id, server URL, cursor, last pull time, last error). The integer `templates.id` stays, because job rows, the local API and the print pipeline reference it; it is never sent to the server and differs between PCs.

### Typing both sides

- **Hosted API:** a client generated from OpenAPI (section 10).
- **Local agent:** wrap `invoke` in one typed `agent` module with a function per command and its request and result types. The end-to-end suite's fake agent is type-checked against the same module (section 11). Generating those types from Rust with `tauri-specta` is an option; I did not check it against this project's Tauri version.
- **Browser-only use:** `isWebMode()` in `webGuard.ts` already blocks native features. The hosted API works in a browser, so a web Designer without printing becomes possible later.

## 7. Data model

The cloud database keeps the four existing tables, fixes their rough edges, and adds the tables for everything that moves to the server: versions, datasets, profiles, settings, fonts, and the change tracking that makes delta sync possible. Template ids stay the client-generated UUIDs, so every `remote_id` already stored in installed apps stays valid. Every other synced record also gets a client-generated UUID, which makes each `PUT` idempotent. Documentation only; the real file is `prisma/schema.prisma`. Under Prisma 7 it also needs a `generator` block with an explicit `output`, and the `datasource` block has no `url`: the connection string lives in `prisma.config.ts` (section 12).

```prisma
model User {
  id           String          @id @default(uuid()) @db.Uuid
  handle       String                                   // as typed, 1 to 32 of A-Z a-z 0-9 _ -
  handleKey    String          @unique @map("handle_key") // lowercase of handle; case-insensitive uniqueness
  passwordHash String          @map("password_hash")
  createdAt    DateTime        @default(now()) @map("created_at") @db.Timestamptz
  sessions     Session[]
  templates    Template[]
  saved        SavedTemplate[]
  sync         UserSync?
  @@map("users")
}

model Session {
  tokenHash String   @id @map("token_hash")            // SHA-256 hex of the opaque token
  userId    String   @map("user_id") @db.Uuid
  expiresAt DateTime @map("expires_at") @db.Timestamptz
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId])
  @@index([expiresAt])
  @@map("sessions")
}

model Template {
  id          String          @id @db.Uuid               // client-generated, kept from v1
  ownerId     String          @map("owner_id") @db.Uuid
  name        String
  summary     String          @default("")
  pageWMm     Float           @map("page_w_mm")
  pageHMm     Float           @map("page_h_mm")
  language    String          @default("html")
  body        String                                     // HTML; 512 KiB cap checked in the domain
  css         String          @default("")               // 256 KiB cap
  readme      String          @default("")               // 64 KiB cap
  useCount    Int             @default(0) @map("use_count")
  revision    Int             @default(1)                // +1 on every content change; checked on update
  changeSeq   BigInt          @map("change_seq")         // owner's sequence number at the last change
  publishedAt DateTime?       @map("published_at") @db.Timestamptz // null means private
  createdAt   DateTime        @default(now()) @map("created_at") @db.Timestamptz
  updatedAt   DateTime        @updatedAt @map("updated_at") @db.Timestamptz
  owner       User            @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  savedBy     SavedTemplate[]
  versions    TemplateVersion[]
  datasets    SampleDataset[]
  profiles    PrinterProfile[]
  @@index([ownerId, changeSeq])
  @@index([ownerId, updatedAt])
  @@index([publishedAt, updatedAt])
  @@map("templates")
}

model SavedTemplate {
  userId     String   @map("user_id") @db.Uuid
  templateId String   @map("template_id") @db.Uuid
  addedAt    DateTime @default(now()) @map("added_at") @db.Timestamptz
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  template   Template @relation(fields: [templateId], references: [id], onDelete: Cascade)
  @@id([userId, templateId])
  @@map("saved_templates")
}

// Phase 2: every content-changing PUT appends one row
model TemplateVersion {
  id         String        @id @default(uuid()) @db.Uuid
  templateId String        @map("template_id") @db.Uuid
  versionNo  Int           @map("version_no")
  body       String
  css        String        @default("")
  label      String?
  note       String?
  createdBy  VersionSource @map("created_by")
  createdAt  DateTime      @default(now()) @map("created_at") @db.Timestamptz
  template   Template      @relation(fields: [templateId], references: [id], onDelete: Cascade)
  @@unique([templateId, versionNo])
  @@map("template_versions")
}

// Matches the app's CHECK constraint. `sync` is gone: pulling a server copy no longer
// writes a version, because versions now live on the server (this removes the cause of P2).
enum VersionSource { manual autosave restore }

// Change tracking (Phase 1 creates these two; Phase 2 starts using them)
model UserSync {
  userId   String @id @map("user_id") @db.Uuid
  nextSeq  BigInt @default(1) @map("next_seq")   // locked and incremented inside every synced write
  user     User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@map("user_sync")
}

model Tombstone {
  userId    String   @map("user_id") @db.Uuid
  seq       BigInt
  entity    String                                // template | dataset | profile | setting | font
  entityKey String   @map("entity_key")           // the UUID, or the setting key
  deletedAt DateTime @default(now()) @map("deleted_at") @db.Timestamptz
  @@id([userId, seq])
  @@index([userId, deletedAt])
  @@map("tombstones")
}

// Phase 4
model SampleDataset {
  id         String   @id @db.Uuid                 // client-generated
  templateId String   @map("template_id") @db.Uuid
  name       String
  json       String                                // 256 KiB cap
  isDefault  Boolean  @default(false) @map("is_default")
  revision   Int      @default(1)
  changeSeq  BigInt   @map("change_seq")
  template   Template @relation(fields: [templateId], references: [id], onDelete: Cascade)
  @@index([templateId])
  @@map("sample_datasets")
}

model PrinterProfile {
  id          String   @id @db.Uuid                // client-generated
  userId      String   @map("user_id") @db.Uuid
  templateId  String   @map("template_id") @db.Uuid
  printerKey  String   @map("printer_key")         // lowercase printer name, as the local API matches it
  settingsJson String  @map("settings_json")       // 64 KiB cap
  revision    Int      @default(1)
  changeSeq   BigInt   @map("change_seq")
  template    Template @relation(fields: [templateId], references: [id], onDelete: Cascade)
  @@unique([userId, templateId, printerKey])
  @@index([userId, changeSeq])
  @@map("printer_profiles")
}

model UserSetting {
  userId    String @map("user_id") @db.Uuid
  key       String                                 // must be in the server's allow-list
  value     String                                 // 256 KiB cap (the brand logo is the largest)
  revision  Int    @default(1)
  changeSeq BigInt @map("change_seq")
  @@id([userId, key])
  @@map("user_settings")
}

model Font {
  id        String   @id @db.Uuid                  // client-generated
  userId    String   @map("user_id") @db.Uuid
  family    String
  style     String   @default("normal")
  weight    String   @default("400")
  format    String                                 // ttf | otf | woff | woff2
  sizeBytes Int      @map("size_bytes")
  sha256    String                                 // of the file; also its ETag
  revision  Int      @default(1)
  changeSeq BigInt   @map("change_seq")
  file      FontFile?
  @@index([userId, changeSeq])
  @@map("fonts")
}

model FontFile {                                   // bytes kept apart so list queries never load them
  fontId String @id @map("font_id") @db.Uuid
  data   Bytes
  font   Font   @relation(fields: [fontId], references: [id], onDelete: Cascade)
  @@map("font_files")
}
```

### How change tracking works

Delta sync needs a cursor the server can trust. Two obvious choices fail:

- **`updated_at`** can be equal for different rows and moves with clock changes, so a page can skip a row.
- **A global database sequence** hands out numbers before the transaction commits, so a reader can pass number 12 while the transaction holding number 11 is still open, and then never see 11.

The design: every write that changes synced data runs, in the same transaction, `UPDATE user_sync SET next_seq = next_seq + 1 WHERE user_id = $1 RETURNING next_seq`. That takes a row lock on the user's `user_sync` row, so one user's writes commit in the order their numbers were given, and the cursor never has a gap. The number is stored in the changed row's `change_seq`. Different users never block each other. The cost is that one user's concurrent writes queue briefly, which is fine at the rate one person edits templates.

- **Upserts** are read straight from the row: `change_seq > cursor`, in order.
- **Deletes** write a row in `tombstones` with the next number. Deleting a template also writes tombstones for its datasets and profiles, in the same transaction, because the database cascade alone would leave no trace.
- **Retention:** tombstones older than 90 days (`SYNC_TOMBSTONE_DAYS`) are purged by the hourly cleanup. A cursor below the oldest remaining number gets `reset: true`.
- **Versions are not in the stream.** The stream carries each template's `version_count` and head version number; version bodies are fetched on demand (section 8).
- **Saved templates are not in the stream.** Their change numbers belong to the author, so they use the saved manifest instead.

### What changes from the current server tables

| Current | New | Reason |
| --- | --- | --- |
| `published_at = ''` means private | `published_at` is null when private | No sentinel value (P16) |
| Mixed timestamp formats | `timestamptz`, sent as RFC 3339 UTC with `Z` | Fixes the client's local-time parsing (P16) |
| `handle ... COLLATE NOCASE` | `handleKey` holds the lowercase handle | Works on any database |
| No concurrency check | `revision` integer, checked on every update | Mandatory optimistic concurrency, Phase 2. It is what lets a cache push safely |
| No change tracking | `change_seq` on synced rows, `tombstones`, `user_sync` | Delta sync |
| No version history on the server | `TemplateVersion`, every content change appends one | Server is the source of truth for history |
| `DELETE` is called "unpublish" in the client | Separate `publish`, `unpublish` and `DELETE` | Clear meaning for each action |
| `compiled_css` exists only locally | Stays local; the app recompiles Tailwind when it applies a pulled template | Output depends on the app's compiler revision |
| `sample_datasets`, `presets` local tables, unused by Rust | `sample_datasets` becomes a server table (Phase 4); `presets` is dropped | No code reads or writes `presets` |

### Migrating existing data

One import script reads the Rust server's `printninja-server.db` and writes through Prisma. Run it on a copy first, with a dry-run flag, and compare row counts.

- **users:** keep `id` and `password_hash` unchanged. The hashes are scrypt PHC strings, so the new service verifies them and rehashes to argon2id on the next login. Create a `user_sync` row for each.
- **sessions:** keep unexpired rows. The stored value is the SHA-256 of the token, so installed apps stay signed in.
- **templates:** keep `id`; convert `''` in `published_at` to null; treat SQLite `datetime('now')` values as UTC. Set `revision = 1` and assign `change_seq` per owner in `created_at` order, then set that owner's `next_seq` past the last one. Insert the current content as version 1 with the label "Imported".
- **saved\_templates:** copy as is.
- **Cutover:** run the Rust server read-only, import, point the apps at the new URL, then retire it. Installed apps adopt their local templates on first sync (section 12, Phase 3).

## 8. API specification

The hosted API has 16 endpoints from Phases 1 and 2, 6 more in Phase 2 (versions, delta sync, saved manifest), and 10 in Phase 4 (datasets, profiles, settings, fonts): 32 in total. It replaces the 13 operations of the Rust share server. The local agent API stays in Rust and is documented at the end of this section.

### Conventions

- Base path `/v2`. JSON in and out, UTF-8. Font files are the one binary exception.
- Field names stay `snake_case`, as in the current client and the Rust structs, so the frontend rename is limited to the error envelope and pagination.
- Ids are UUID strings. Times are RFC 3339 in UTC with a `Z`, for example `2026-10-20T02:15:00Z`.
- Authentication is `Authorization: Bearer <token>`, an opaque 32-byte token valid for 30 days. Details in section 9.
- Every synced record has a `revision` that starts at 1 and rises by one on each content change. `GET` responses for a single template also carry `ETag: "<revision>"`.

### Hosted API endpoints

| # | Method and path | Auth | Purpose | Replaces | Phase |
| --- | --- | --- | --- | --- | --- |
| 1 | `POST /v2/auth/register` | none | Create an account and a session | `POST /v1/auth/register` | 1 |
| 2 | `POST /v2/auth/login` | none | Start a session | `POST /v1/auth/login` | 1 |
| 3 | `POST /v2/auth/logout` | required | End the current session | `POST /v1/auth/logout` | 1 |
| 4 | `GET /v2/auth/me` | required | Current user | `GET /v1/auth/me` | 1 |
| 5 | `PUT /v2/templates/{id}` | owner | Create or update by client UUID, always private on create; checked against `if_revision` | `PUT /v1/templates/{id}` | 2 |
| 6 | `GET /v2/templates/{id}` | optional | Read one; private only for its owner; supports `If-None-Match` | `GET /v1/templates/{id}` | 2 |
| 7 | `DELETE /v2/templates/{id}` | owner | Delete permanently | `DELETE /v1/templates/{id}` | 2 |
| 8 | `POST /v2/templates/{id}/publish` | owner | Make it public; keeps the first publish time | `PUT` with `publish: true` | 2 |
| 9 | `POST /v2/templates/{id}/unpublish` | owner | Make it private | `PUT` with `publish: false` | 2 |
| 10 | `GET /v2/templates/mine` | required | Own templates, private and public (summaries; the app uses sync instead) | `GET /v1/templates/mine` | 2 |
| 11 | `GET /v2/community/templates` | none | Published templates; search, sort, pages | `GET /v1/templates` | 2 |
| 12 | `POST /v2/templates/{id}/use` | required | Count prints of a published template | `POST /v1/templates/{id}/use` | 2 |
| 13 | `GET /v2/saved` | required | Saved community templates | `GET /v1/saved` | 2 |
| 14 | `PUT /v2/saved/{id}` | required | Save a published template | `PUT /v1/saved/{id}` | 2 |
| 15 | `DELETE /v2/saved/{id}` | required | Remove from the saved list | `DELETE /v1/saved/{id}` | 2 |
| 16 | `GET /v2/health` | none | Liveness and version | `GET /health` | 1 |
| 17 | `GET /v2/templates/{id}/versions` | owner | Version list | new | 2 |
| 18 | `GET /v2/templates/{id}/versions/{n}` | owner | One version, with body and CSS | new | 2 |
| 19 | `POST /v2/templates/{id}/versions/{n}/restore` | owner | Make version `n` the current content, as a new revision and a new version | new | 2 |
| 20 | `DELETE /v2/templates/{id}/versions/{n}` | owner | Delete one version; the newest cannot be deleted | new | 2 |
| 21 | `GET /v2/sync/changes` | required | Everything the user owns that changed after a cursor, and what was deleted | new | 2 (templates), 4 (the rest) |
| 22 | `GET /v2/saved/manifest` | required | Revision and state of every saved template | new | 2 |
| 23 | `PUT /v2/datasets/{id}` | owner | Create or update a sample dataset | `sample_datasets` (local, unused) | 4 |
| 24 | `DELETE /v2/datasets/{id}` | owner | Delete a dataset | new | 4 |
| 25 | `PUT /v2/profiles/{id}` | required | Create or update a printer profile | `printer_profiles` (local) | 4 |
| 26 | `DELETE /v2/profiles/{id}` | required | Delete a profile | new | 4 |
| 27 | `PUT /v2/settings/{key}` | required | Set an account preference; the key must be in the allow-list | `settings` (local) | 4 |
| 28 | `DELETE /v2/settings/{key}` | required | Reset a preference | new | 4 |
| 29 | `PUT /v2/fonts/{id}` | required | Create or update font metadata | `fonts` (local) | 4 |
| 30 | `PUT /v2/fonts/{id}/file` | required | Upload the font bytes; checked against the format and size | new | 4 |
| 31 | `GET /v2/fonts/{id}/file` | required | Download the bytes; `ETag` is the SHA-256 | new | 4 |
| 32 | `DELETE /v2/fonts/{id}` | required | Delete a font and its file | new | 4 |

`GET /openapi.json` and `GET /docs` serve the generated contract and Swagger UI and are not part of the versioned API.

### TypeScript types

Documentation only. The real types are generated from the OpenAPI file (section 10).

```ts
type Uuid = string;
type IsoDateTime = string;                  // RFC 3339 UTC, e.g. "2026-10-20T02:15:00Z"

interface User { id: Uuid; handle: string; created_at: IsoDateTime }
interface RegisterRequest { handle: string; password: string }  // handle 1-32 of A-Za-z0-9_- ; password 8-128 chars
interface LoginRequest { handle: string; password: string }
interface AuthResponse { token: string; expires_at: IsoDateTime; user: User }

interface TemplateSummary {
  id: Uuid; owner_id: Uuid; owner_handle: string;
  name: string; summary: string;
  page_w_mm: number; page_h_mm: number; language: "html";
  use_count: number; revision: number;
  version_count: number;
  published_at: IsoDateTime | null;         // null = private
  updated_at: IsoDateTime;
}
interface Template extends TemplateSummary { body: string; css: string; readme: string }

interface PutTemplateRequest {
  name: string;                             // 1-120 chars
  summary?: string;                         // up to 500
  page_w_mm: number; page_h_mm: number;     // > 0 and <= 2000
  language?: "html";
  body: string;                             // up to 512 KiB (bytes)
  css?: string;                             // up to 256 KiB; omitted keeps the stored value, "" clears it
  readme?: string;                          // up to 64 KiB
  if_revision?: number;                     // required when the template exists; omit on create
  version?: { created_by?: "manual" | "autosave"; label?: string; note?: string };  // how the new version is recorded; default manual
}

interface Page<T> { items: T[]; page: number; page_size: number; total: number; has_more: boolean }

type ErrorCode =
  | "validation_failed" | "remote_reference" | "payload_too_large"
  | "unauthorized" | "invalid_credentials" | "forbidden" | "not_found"
  | "handle_taken" | "revision_conflict" | "revision_required" | "quota_exceeded"
  | "rate_limited" | "internal_error";
interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: { path: string; message: string }[]; request_id: string };
}
```

### Endpoint reference

Every error uses the envelope in section 9. Path ids are UUID strings; a path id that is not a UUID is a `400 validation_failed`. Numbers match the table above.

| # | Request | Success | Errors |
| --- | --- | --- | --- |
| 1 | Body `RegisterRequest` | `201` `AuthResponse` | 400, 409 `handle_taken`, 429 |
| 2 | Body `LoginRequest` | `200` `AuthResponse` | 400, 401 `invalid_credentials`, 429 |
| 3 | None | `204` | 401 |
| 4 | None | `200` `User` | 401 |
| 5 | Path `id`, body `PutTemplateRequest` | `201` `Template` when created, `200` when updated or replayed | 400 (`validation_failed` or `remote_reference`), 401, 403, 409 `revision_conflict`, 413, 428 `revision_required` |
| 6 | Path `id`; optional `If-None-Match` | `200` `Template` with `ETag`, or `304` | 401 (a token was sent and is invalid), 404 |
| 7 | Path `id` | `204` | 401, 403, 404 |
| 8 | Path `id`, no body | `200` `Template`; keeps the first publish time | 401, 403, 404 |
| 9 | Path `id`, no body | `204` | 401, 403, 404 |
| 10 | Query `page`, `page_size` | `200` `Page<TemplateSummary>`, newest `updated_at` first | 400, 401 |
| 11 | Query `q`, `sort`, `page`, `page_size` | `200` `Page<TemplateSummary>` | 400, 429 |
| 12 | Path `id`; optional body `{ count }`, 1 to 100, default 1 | `204` | 400, 401, 404 (missing or not published) |
| 13 | Query `page`, `page_size` | `200` `Page<TemplateSummary>`, most recently saved first | 400, 401 |
| 14 | Path `id` | `204`, safe to repeat | 401, 404 (missing or not published), 409 `quota_exceeded` (more than 1,000 saved) |
| 15 | Path `id` | `204`, also when it was not saved | 401 |
| 16 | None | `200` `{ "status": "ok", "version": "0.1.0" }` | None |
| 17 | Path `id`, query `page`, `page_size` | `200` `Page<TemplateVersionSummary>`, newest first | 400, 401, 403, 404 |
| 18 | Path `id` and `n` | `200` `TemplateVersion` | 401, 403, 404 |
| 19 | Path `id` and `n`, body `{ if_revision }` | `200` `Template` | 401, 403, 404, 409 `revision_conflict`, 428 |
| 20 | Path `id` and `n` | `204` | 400 (the newest version), 401, 403, 404 |
| 21 | Query `since`, `limit`, `types` | `200` `ChangesResponse` | 400, 401 |
| 22 | None | `200` `SavedManifest` | 401 |
| 23 | Path `id`, body `PutDatasetRequest` | `201` or `200` `SampleDataset` | 400, 401, 403, 404 (template), 409 `revision_conflict`, 413, 428 |
| 24 | Path `id` | `204`, also when missing | 401, 403 |
| 25 | Path `id`, body `PutProfileRequest` | `201` or `200` `PrinterProfile` | 400, 401, 404 (template), 409 `revision_conflict`, 413, 428 |
| 26 | Path `id` | `204`, also when missing | 401, 403 |
| 27 | Path `key`, body `{ value, if_revision? }` | `200` `Setting` | 400 (key not in the allow-list), 401, 409 `revision_conflict`, 413 |
| 28 | Path `key` | `204` | 400, 401 |
| 29 | Path `id`, body `PutFontRequest` | `201` or `200` `Font` | 400, 401, 403, 409 `quota_exceeded` (more than 50 fonts) |
| 30 | Path `id`, raw bytes, `Content-Type: application/octet-stream` | `200` `Font` with the SHA-256 | 400 (wrong format or content), 401, 403, 404, 413 (over 5 MiB) |
| 31 | Path `id`; optional `If-None-Match` | `200` bytes with `ETag`, or `304` | 401, 403, 404 |
| 32 | Path `id` | `204`, also when missing | 401, 403 |

Rules the table cannot show. Where v1 differs, the bullet says so:

- **Someone else's template.** `PUT`, `DELETE`, publish and unpublish on an existing template you do not own return `403`, as in v1. Only `GET` hides a private template as `404`. Ids are random UUIDs, so the `403` reveals almost nothing, and keeping it means the app's existing handling of "not the owner" still works.
- **`PUT` and visibility.** v1 publishes a brand-new template when `publish` is omitted (`server/src/main.rs:480`, `server-legacy/` after Phase 1). v2 never does: a created template is private, and only `POST .../publish` changes visibility.
- **`PUT` and omitted fields.** `css`, `summary` and `readme` keep their stored value when omitted; send `""` to clear one. v1 kept `css` but reset `summary` and `readme` to empty, so an older client could wipe a README by accident.
- **Revisions.** Creating a template needs no `if_revision`. Updating one without it is `428 revision_required`. A stale `if_revision` is `409 revision_conflict`, and `details` carries the stored revision. Each accepted content change raises `revision` by one.
- **Replay of a lost response.** If `if_revision` is stale but the request's content equals what is stored, the server answers `200` with the stored revision and changes nothing. A push whose answer was lost on the network is therefore not a conflict.
- **Versions.** Every accepted `PUT` that changes `body` or `css` appends a version with the next `version_no`. Changes to name, summary, README or page size alone do not. Autosave versions beyond the newest 50 per template are deleted when a new one is added; `manual` and `restore` versions are kept until someone deletes them. Restoring version `n` copies its body and CSS into the template as a new revision and records a new `restore` version, so no history is lost.
- **Publish and unpublish** do not change the content, so they leave `revision` alone, but they take a new sequence number. The owner's other PCs learn the new visibility through the next pull, and a PC that edits the body is not forced into a conflict by a visibility change made elsewhere.
- **`GET /v2/templates/{id}`.** No `Authorization` header: published templates only. A valid token: also your own private ones. A token that is present but invalid: `401`, as v1 does. `If-None-Match: "<revision>"` returns `304` when the revision is unchanged.
- **Saved list.** A template its author has unpublished is left out of `GET /v2/saved`, as in v1. The saved manifest (below) reports it as `withdrawn`, which is how a cache learns about it without guessing from an absence.
- **`AuthResponse`.** v1 returned `{ token, user }`. v2 adds `expires_at`.
- **`POST .../use`** counts `count` (default 1) per call from a signed-in user. The app sends counts it queued while printing offline. See question 8 in section 13 (answered: rate limit only for now).

### Delta sync: `GET /v2/sync/changes`

```http
GET /v2/sync/changes?since=Mjc4&limit=100&types=template,dataset,profile,setting,font
Authorization: Bearer 3q2-7wR...
```

```ts
type SyncEntity = "template" | "dataset" | "profile" | "setting" | "font";
type Change =
  | { seq: string; entity: "template"; op: "upsert"; data: Template }          // includes version_count, head version number
  | { seq: string; entity: "dataset"; op: "upsert"; data: SampleDataset }
  | { seq: string; entity: "profile"; op: "upsert"; data: PrinterProfile }
  | { seq: string; entity: "setting"; op: "upsert"; data: Setting }
  | { seq: string; entity: "font";    op: "upsert"; data: Font }               // metadata only, never the bytes
  | { seq: string; entity: SyncEntity; op: "delete"; id: string };             // id is the setting key for settings
interface ChangesResponse {
  changes: Change[];                         // in sequence order, one record per entity (the newest state)
  next_cursor: string;                       // opaque; store it and send it back as `since`
  has_more: boolean;                         // true: call again at once with next_cursor
  reset: boolean;                            // true: `since` was too old; this response starts a full pass
}
```

- **`since` omitted or empty** is a first sync and returns everything the user owns. **`since`** is the `next_cursor` from the previous response, an opaque base64 string.
- **Pages** stop at `limit` records (default 100, at most 500) or at a byte budget of 8 MiB (`SYNC_PAGE_BYTES`), whichever is first. One template can be 832 KiB, so the byte budget matters more than the count.
- **Resuming is safe.** A record that changes again after its page was read appears again in a later page. Applying a record by its `revision` is idempotent.
- **`reset: true`** is returned when `since` is older than the oldest kept tombstone. The response then behaves like a first sync from the start, and the client removes every synced cache row it does not see in the pass.
- **Scope.** Only the signed-in user's own records. Saved community templates use the manifest. Version bodies are fetched with endpoints 17 and 18.
- **Cost.** An up-to-date client gets `{ changes: [], has_more: false }` from one indexed range read per table, so polling once a minute is cheap. It counts against the normal rate limit.

### Saved manifest: `GET /v2/saved/manifest`

```ts
interface SavedManifest {
  items: { id: Uuid; revision: number; state: "published" | "withdrawn" | "deleted"; owner_handle: string; updated_at: IsoDateTime }[];
}
```

Small by construction: ids and revisions only, bounded by the 1,000-item saved cap. The app compares each `revision` with its cached copy, fetches the ones that differ with `GET /v2/templates/{id}` and `If-None-Match`, and marks `withdrawn` and `deleted` copies in the UI.

### Library types (Phase 4)

```ts
interface SampleDataset { id: Uuid; template_id: Uuid; name: string; json: string; is_default: boolean; revision: number }
interface PutDatasetRequest { template_id: Uuid; name: string; json: string; is_default?: boolean; if_revision?: number }   // json up to 256 KiB
interface PrinterProfile { id: Uuid; template_id: Uuid; printer_key: string; settings_json: string; revision: number }
interface PutProfileRequest { template_id: Uuid; printer_key: string; settings_json: string; if_revision?: number }       // one per user, template and printer_key
interface Setting { key: string; value: string; revision: number }
interface Font { id: Uuid; family: string; style: string; weight: string; format: "ttf" | "otf" | "woff" | "woff2"; size_bytes: number; sha256: string | null; revision: number }
interface PutFontRequest { family: string; style?: string; weight?: string; format: "ttf" | "otf" | "woff" | "woff2" }
```

- **Settings allow-list.** The server accepts only keys it lists (`ui_density`, `brand_name`, `brand_logo` to start). Anything else is `400`, so a device setting can never be stored by accident.
- **Fonts.** Metadata and bytes are two calls, so a failed upload leaves a font with `sha256: null`, which the app shows as not ready and retries. The server checks the first bytes against the declared format, rejects files over 5 MiB (`FONT_MAX_BYTES`), and computes the SHA-256. Fonts are private to their owner and are never part of a published template.
- **Profiles.** `printer_key` is the lowercase printer name, matching how the local API finds printers (question 20, answered).

### Version types

```ts
type VersionSource = "manual" | "autosave" | "restore";
interface TemplateVersionSummary { version_no: number; label: string | null; note: string | null; created_by: VersionSource; created_at: IsoDateTime }
interface TemplateVersion extends TemplateVersionSummary { body: string; css: string }
```

### Example: register and a failed duplicate

```http
POST /v2/auth/register
{ "handle": "Rafi", "password": "correct horse battery" }
```

```http
201 Created
{ "token": "3q2-7wR...", "expires_at": "2026-11-19T02:10:00Z",
  "user": { "id": "5d0c...", "handle": "Rafi", "created_at": "2026-10-20T02:10:00Z" } }
```

```http
POST /v2/auth/register
{ "handle": "rafi", "password": "another password" }
```

```http
409 Conflict
{ "error": { "code": "handle_taken", "message": "That handle is already in use",
             "request_id": "0b7a8f10-6c1e-4c0a-9d0e-5f2a7d9c1b33" } }
```

### Local agent API (stays in Rust)

The local REST API on `127.0.0.1:17717` is for automation scripts on the same machine. It stays in the Rust app because every call ends in a print. It is off by default; the setting `api_lan_access` makes it bind `0.0.0.0` and allow any browser origin. I read it from `src-tauri/src/api/routes.rs` and `openapi.rs`.

- **Auth:** `Authorization: Bearer pn_live_...` on everything except `GET /v1/health`.
- **Idempotency:** an `Idempotency-Key` header that matches an existing job returns `200 { "status": "duplicate" }` and creates nothing. The check runs in middleware before any route, and before the job row exists (P12).
- **Errors:** `{ "error": "<text>" }` with `400`, `401`, `404` or `500`. This is not the hosted envelope. I recommend leaving it alone, because existing scripts depend on it.
- **Wire shape:** keep `/v1` exactly as it is, and fix behaviour behind it in Phase 0.

| Method and path | Request | Success | Notes |
| --- | --- | --- | --- |
| `GET /v1/health` | None | `200 { status, version, app }` | Open, no key |
| `GET /v1/printers` | None | `200 { printers: [{ id, name, type, address, language }], count }` | |
| `GET /v1/templates` | None | `200 { templates: [{ id, name, page_w_mm, page_h_mm, orientation, version_count }], count }` | |
| `POST /v1/print` | `{ template, printer, data?, data_url?, settings?, test?, callback_url? }` | `200 { job_id, status: "success", duration_ms }` | `template` and `printer` are names, matched ignoring case. Blocks until printed. `500` on a transport failure. `callback_url` is accepted and ignored (P12). `data_url` is fetched with no address limits (P13) |
| `POST /v1/print/batch` | `{ template, printer, data: [...], mode?: "per_record" \| "single_job" }` | `202 { batch_id, status: "queued", records, mode }` | Rows are written but never printed (P3). No 5,000-record cap on this path |
| `GET /v1/jobs` | None | `200 { jobs: [{ id, status, source, copies, created_at }], count }` | No paging or filters |
| `GET /v1/jobs/{id}` | None | `200 { id, status, error, duration_ms, copies, source, created_at }` | `404` if unknown |
| `DELETE /v1/jobs/{id}` | None | `204` | `400` unless the job is still `queued` |
| `POST /v1/jobs/{id}/retry` | None | `200 { job_id, status: "queued" }` | Only resets the row; nothing prints it (P3) |
| `GET /v1/openapi.json` | None | `200` OpenAPI document | Hand-written in `openapi.rs`; says `data` is required on `POST /v1/print` while the code treats it as optional (P12). Needs a key |

## 9. Response, error, pagination and auth contracts

### Success responses

- A single resource is returned as the bare object, as today, so the client mapping stays small.
- A list that can grow is returned as `Page<T>`: `{ items, page, page_size, total, has_more }`. `GET /v2/templates/mine` and `GET /v2/saved` are bounded per user and also use `Page<T>`, so every list has one shape.
- `DELETE`, `logout`, `use` and `unpublish` return `204 No Content`. `PUT` returns `201` when it creates and `200` when it updates.

### Error envelope

Every failure, including framework-level ones (bad JSON, unknown route, body too large), uses one shape, built by a single error handler:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Request body is invalid",
    "details": [{ "path": "page_w_mm", "message": "Number must be greater than 0" }],
    "request_id": "7f6e2c1a-3b0e-4d57-9c1f-2f1d0b6a9e11"
  }
}
```

The v1 client does `err.error || ...` and expects a string, so it would show `[object Object]` here. That is one more reason `/v2` is a new path and not a change to `/v1`.

| Status | Code | When |
| --- | --- | --- |
| 400 | `validation_failed` | Malformed JSON, wrong types, out-of-range values, bad query parameters |
| 400 | `remote_reference` | The template body or CSS loads something from the network (the check the client already runs, now enforced on the server too) |
| 401 | `unauthorized` | Missing, unknown or expired token |
| 401 | `invalid_credentials` | Login failed; the same answer for an unknown handle and a wrong password |
| 403 | `forbidden` | Authenticated but not allowed, for example changing someone else's template |
| 404 | `not_found` | Missing, or private and owned by someone else (the same answer on purpose, so ids cannot be probed) |
| 409 | `handle_taken` | Register with an existing handle (v1 returned 400) |
| 409 | `revision_conflict` | `if_revision` does not match; the body carries the stored revision in `details` |
| 409 | `quota_exceeded` | A per-user cap is reached: 50 fonts, 1,000 saved templates |
| 428 | `revision_required` | An update to an existing record without `if_revision` |
| 413 | `payload_too_large` | Body over the limit, including a font over 5 MiB |
| 429 | `rate_limited` | Too many requests; includes a `Retry-After` header |
| 500 | `internal_error` | Anything unexpected; details go to the log, never to the client |

I use 400 for validation and not 422, to match what clients already handle. One code, one status, no overlap.

### Validation

- Zod schemas on every body, query and path parameter, in the `http` layer. They are also the OpenAPI source, so nothing is described twice.
- The domain re-checks only business rules Zod cannot express (ownership, published-only for save and use).
- Strings are trimmed. Handles are matched case-insensitively through `handleKey`, which is what removes the duplicate-handle bug.
- Body limits: 1 MiB for `PUT /templates`, `PUT /datasets` and `PUT /settings`; 5 MiB for `PUT /fonts/{id}/file`; 16 KiB for everything else.
- Search text is escaped before it reaches the database, which fixes the unescaped LIKE wildcards (P16).

### Pagination, search and sort

`GET /v2/community/templates?q=&sort=updated&page=1&page_size=20`

| Parameter | Default | Limits |
| --- | --- | --- |
| `q` | none | 1-100 chars; matches name, summary and owner handle |
| `sort` | `updated` | `updated`, `used`, `name` |
| `page` | 1 | 1 or more |
| `page_size` | 20 | 1-100 |

Offset pagination is enough at this size. Cursors are the upgrade if a list ever passes tens of thousands of rows, and the envelope would change only by adding `next_cursor`. Ties are broken by `id` so pages never repeat a row.

```json
{ "items": [ { "id": "0c9e...", "name": "Shipping label 4x6", "owner_handle": "rafi", "use_count": 42, "published_at": "2026-10-01T08:00:00Z" } ],
  "page": 1, "page_size": 20, "total": 57, "has_more": true }
```

### Authentication

- Register and login return `{ token, expires_at, user }`. The token is 32 random bytes, base64url. Only its SHA-256 hash is stored in `Session`, so a database leak does not leak live tokens.
- Expiry is 30 days from creation (`SESSION_TTL_DAYS`). Expired rows are deleted by a cleanup that runs on startup and every hour; there is no job queue.
- Passwords are hashed with argon2id. Imported scrypt hashes are verified once and re-hashed to argon2id on the user's next successful login.
- A single `requireAuth` hook reads the bearer token and attaches `{ userId, sessionId }`. Public routes simply do not use it. `GET /v2/templates/{id}` uses an optional variant so owners can read their private copy.
- Logout deletes only the current session.
- Rate limits: login and register per IP and per handle (for example 10 per 5 minutes), everything else per token or IP (for example 120 per minute). Real client IPs need `TRUST_PROXY` set to the hop count of the actual proxy; trusting `X-Forwarded-For` blindly is the existing bug, so it defaults to off. The sync endpoint is polled about once a minute per PC and counts against the general limit.
- CORS is an explicit allow-list from `CORS_ORIGINS`, replacing `permissive`. The Tauri webview origins (`tauri://localhost`, `http://tauri.localhost`) are listed there.

### Example: save, then publish

```http
PUT /v2/templates/3b8f6d0e-6a1c-4f7e-9d8b-1a2b3c4d5e6f
Authorization: Bearer 3q2-7wR...

{ "name": "Shipping label 4x6", "page_w_mm": 101.6, "page_h_mm": 152.4,
  "body": "<div>{{order.id}}</div>", "css": "", "readme": "" }
```

```http
201 Created
{ "id": "3b8f6d0e-...", "owner_id": "...", "owner_handle": "rafi", "name": "Shipping label 4x6",
  "summary": "", "page_w_mm": 101.6, "page_h_mm": 152.4, "language": "html",
  "body": "<div>{{order.id}}</div>", "css": "", "readme": "",
  "use_count": 0, "revision": 1, "version_count": 1, "published_at": null, "updated_at": "2026-10-20T02:15:00Z" }
```

```http
POST /v2/templates/3b8f6d0e-.../publish   ->   200, same body with "published_at": "2026-10-20T02:16:10Z"
```

`PUT` never changes visibility; publish and unpublish are separate calls, and the next `PUT` of the same template must carry `"if_revision": 1`. That replaces the v1 `publish` boolean whose three meanings (true, false, omitted) are what `saveToServer` has to work around today.

## 10. OpenAPI and frontend type generation

The goal is one place where the contract is written. Here it is the Zod schemas in `server/src/http/schemas/`. Everything else is generated from them or checked against them. Because the service and the app are in one repository, a contract change and the app change that follows it travel in one pull request.

### Flow

1. Each route declares its Zod schemas for params, query, body and every response, including the shared `ErrorBody`.
2. `fastify-type-provider-zod` uses those schemas for runtime validation and for handler types, so a handler that returns the wrong shape fails to compile.
3. `@fastify/swagger` turns the same schemas into an OpenAPI 3.1 document. `@fastify/swagger-ui` serves it at `/docs`, and the raw JSON at `/openapi.json`.
4. `pnpm --filter server openapi:generate` writes the document to `server/openapi/openapi.json`, and that file is committed. Reviewers see contract changes in the diff.
5. CI regenerates the file and fails if it differs from the committed one (drift check).
6. The app's root script `pnpm gen:api` runs `openapi-typescript` on that file and writes `src/lib/api/schema.d.ts`, which is committed too. The app uses `openapi-fetch` for calls. Paths, bodies and responses are then typed, with no hand-written entity types.
7. CI regenerates `schema.d.ts` and fails if it differs from the committed one, then type-checks the app. A server change that breaks a call site therefore fails the same pull request that made it.

### How the frontend uses it

- The hand-written `RemoteTemplate`, `PublishPayload` and `RemoteTemplateSummary` interfaces in `src/lib/share/client.ts` are deleted and replaced by types from `schema.d.ts`.
- One middleware on the `openapi-fetch` client adds the bearer token and handles `401` by calling the existing `endSession`, so the `authedFetch` behavior and the sign-in gate keep working.
- The error envelope is parsed in one place, turned into a typed `ApiError` with `code` and `request_id`, and the UI can show the request id to support.
- The existing `ServerUnreachableError` handling stays, because network failures never produce an envelope.
- The sync engine (`src/lib/sync/`) uses the same client, and its change records are typed from the `Change` schema (section 8).

### The local agent side

The Rust IPC commands cannot come from OpenAPI. Phase 3 adds a thin typed `agent` module in the frontend that wraps each `invoke` call with explicit argument and result types, replacing `invoke<any>`. The Playwright fake agent implements the same module's types, so a command that changes shape breaks the e2e build. A Vitest check compares the command names the app calls with the `generate_handler!` list in `src-tauri/src/lib.rs`, so a command that exists in only one place fails fast (section 11). Generating those types from Rust with `tauri-specta` is attractive, but it is not verified against Tauri 2 and this project, so the answer to question 11 in section 13 is: hand-written module first, evaluate `tauri-specta` as a Phase 3 spike, not a commitment. The local REST API (port 17717) keeps its hand-written `openapi.rs`, which is corrected in Phase 0 (the `data` field is optional in code and required in the document).

### Unverified compatibility

The declared peer ranges of Zod, the type provider and the Swagger plugin are compatible (section 4), but I have not installed or run them. Phase 1 starts with a short spike that proves one route generates a valid OpenAPI 3.1 document, and pins the working versions in `server/package.json`.

## 11. Testing strategy

Planning only: no tests are written by this document. The shape is a small pyramid. Most rules are covered by fast unit tests, every route by an integration test against a real PostgreSQL, and a handful of full workflows by end-to-end tests against a running container. A Playwright suite on top of that covers the app itself.

### Where testing stands today

| Area | Today | Consequence |
| --- | --- | --- |
| Share server (`server/`) | 22 `#[tokio::test]` cases at the bottom of `main.rs`: register and login, throttle, private and published visibility, owner checks, size caps, CSS round trip | They describe the current behaviour well. They are the best specification available, so section 12 ports them first |
| CI (`.github/workflows/ci.yml`) | Jobs are `web-check`, `rust-check` and `rust-test-windows`, all for the app. Nothing builds or tests `server/` | The share server's tests never run on a pull request. Fixing this is the first item of Phase 0 |
| Rust app (`src-tauri/tests/`) | 6 files, 58 tests: API routes, batches and profiles, database commands, offline print path, template sync, units | No test calls `get_job`, `reprint_job` or `retry_job`, which is how P1 survived |
| Frontend (`src/test/`) | 25 files on Vitest and jsdom | Share tests mock the client module (`shareSync.test.ts`) or `fetch` (`authGate.test.tsx`), so they cannot notice a server contract change. The generated client in section 10 closes that gap |
| Frontend end to end | None. `playwright-report` and `test-results` are already in `.gitignore`, but the repository has no Playwright dependency, config or spec | Sign-in, sync, conflict and version flows are untested end to end. The suite below fills this |

### Test layers for the new backend

| Layer | What it covers | Real or fake | Speed target |
| --- | --- | --- | --- |
| Unit | Domain services and pure functions | In-memory fakes of every port, a fixed `Clock`, a counting `IdGenerator` | Whole layer under 10 s |
| Integration | Every route through `app.inject()`, every repository against PostgreSQL | Real PostgreSQL in a container, real Prisma, low-cost password hashing | Under 2 min |
| API end to end | Complete workflows over HTTP against the built image | Real image, real PostgreSQL, real network port | Under 5 min |
| Frontend end to end | The app in Chromium against the real service | Real service and PostgreSQL, fake desktop agent | Under 6 min |
| Contract | OpenAPI drift, generated client still compiles in the app | The committed `openapi.json` | Seconds |

Inside `server/` the commands will be `pnpm test:unit`, `pnpm test:int`, `pnpm test:e2e` and `pnpm test` for the first two (section 12). From the repository root, `pnpm e2e` runs the Playwright suite.

### Unit tests (domain, no framework, no database)

Services are built from fakes, so a test is a plain function call.

- **Remote-reference check.** A pure function with a table of cases. It must cover everything the client check in `render/handlebars.rs` catches, which is more than the server's four patterns (P10): single-quoted and unquoted `url()`, protocol-relative `//host`, `@import`, and `src` or `href` in any letter case or with spaces around `=`.
- **Size caps in bytes.** A multi-byte string just under and just over 512 KiB, 256 KiB and 64 KiB. The Rust server counts bytes (`String::len`); JavaScript's `string.length` counts UTF-16 units, so a test must pin this.
- **Handles and passwords.** Allowed characters and length, case-insensitive uniqueness through `handleKey`, trimming.
- **Visibility and ownership.** Private templates are invisible to everyone but the owner; non-owner writes fail; publish keeps the first publish time; unpublish does not delete saved rows.
- **Sessions.** Expiry computed from the fake clock, token hashing, logout removes one session only, expired rows are purged.
- **Use count.** Only published templates count; an unpublished or missing template is a not-found.
- **Config.** The Zod environment schema rejects a missing `DATABASE_URL` and a malformed `CORS_ORIGINS`.
- **Revisions.** An update without `if_revision` is refused; a stale one conflicts; a stale one with identical content is a replay and returns the stored revision; publishing does not change the revision.
- **Versions.** Appended only when `body` or `css` changes; the 51st autosave removes the oldest; restore records a `restore` version; the newest version cannot be deleted.
- **Settings allow-list and fonts.** An unknown setting key is refused; a font whose first bytes do not match its declared format is refused; sizes and counts at, and one past, the caps.

### Integration tests (routes and repositories)

- **Every endpoint:** one happy path, one validation failure, the auth failure, and the 403 or 404 that applies. The endpoint reference in section 8 is the checklist.
- **Envelope everywhere.** Malformed JSON, an unknown route, a wrong method, and a body over the limit must all return the error envelope with a `request_id`, not a framework default page.
- **Pagination.** A tie on `updated_at` never repeats or skips a row across pages; `total` and `has_more` are right on the last page; `q` containing `%` and `_` matches literally (P16).
- **Concurrency, with real commits.** Two registrations of `Rafi` and `rafi` at once give one `201` and one `409`. Fifty parallel `use` calls add exactly fifty. Two `PUT`s of one new id give one create and one update, not a crash.
- **Repository contract suite.** The same set of tests runs twice, once against the in-memory fake and once against the Prisma repository. If the fake ever disagrees with PostgreSQL, a test fails, so unit tests cannot pass on behaviour the real database does not have.
- **Characterization suite.** Port the 22 Rust tests one for one as the first integration tests. Differences that are deliberate in v2, and so change the expected result, are listed in the endpoint reference: duplicate handle is `409` not `400`; a new template stays private when `publish` is omitted (the Rust test `p1_put_without_flag_publishes_new_and_keeps_state_on_update` encodes the old rule); the error body is the envelope.
- **Sync sequence.** Twenty parallel writers for one user produce numbers with no gaps, and a reader polling during the writes never misses a record. Two users writing at once do not block each other.
- **Delta reads.** Upserts and deletes arrive in order; a record changed twice appears once with its newest state; the byte budget splits a page of large templates; a cursor older than the tombstone floor returns `reset: true`; deleting a template also tombstones its datasets and profiles.
- **Migration import.** Run the import script (section 7) against a small fixture database. Assert row counts, that an old session token still authenticates, that an old scrypt password logs in and is rehashed to argon2id, and that `''` in `published_at` became `null`.

### End-to-end workflows

These run against the built image started with Docker Compose, through the generated client so the contract is exercised from the consumer side. Keep the list short; each one crosses several endpoints that no single integration test does.

| # | Workflow | Steps and what must hold |
| --- | --- | --- |
| E1 | Account lifecycle | Register, `me`, logout, token now `401`, login, `me`. Wrong password and unknown handle give the same `invalid_credentials`. Same handle in another case gives `409` |
| E2 | Save, publish, discover | User A saves private (`201`). A reads it, anonymous and user B get `404`. A publishes. Anonymous reads it and finds it by search in the community list |
| E3 | Save and use | B saves the published template, sees it in `GET /v2/saved`, records a use, and the count rises by one for everyone |
| E4 | Withdrawal | A unpublishes. B's saved list no longer contains it, the community list no longer shows it, B's `use` is `404`. A republishes and the original publish time is kept |
| E5 | Ownership | B tries `PUT`, `DELETE`, publish and unpublish on A's template: all `403`. A deletes it; it disappears from B's saved list |
| E6 | Update without losing data | A `PUT`s a template, then `PUT`s again with only `body` changed: `css` and `readme` are kept. Without `if_revision` the result is `428`; with a stale one it is `409` and nothing changes |
| E7 | Limits | A `body` field of 512 KiB plus one byte gives `413 payload_too_large` (the code the 1 MiB request limit also uses; v1 returned `400`); a body that loads `https://...` gives `400 remote_reference` |
| E8 | Rate limit | The eleventh login in the window gives `429` with `Retry-After`; another handle from another address is unaffected |
| E9 | Cutover rehearsal | Import a copy of the real Rust database into a clean stack. A pre-existing user signs in with the old password and old token, lists their templates, and an installed app's `remote_id` still resolves |
| E10 | Delta sync | One client creates, edits, publishes and deletes templates. A reader following `GET /v2/sync/changes` from the start sees each change once in order, gets the deletion as a `delete` record, and an up-to-date cursor returns an empty page. A cursor survives a restart of the service. A cursor older than the tombstone floor gives `reset: true` |
| E11 | Revisions | Two clients update one template from the same revision: one `200`, one `409`. A retry of the winning request returns `200` with the same revision (replay). Publishing from one client does not make the other client's next body push conflict |
| E12 | Version history | Three saves give three versions. Restore version 1 and the list shows a fourth, `restore`, version. The newest cannot be deleted. Sixty autosaves leave fifty |
| E13 | Library data (Phase 4) | A dataset, a profile, a setting and a font are created through the API and appear in the sync stream. A setting key outside the allow-list is `400`. A font with a wrong signature is `400`; one over 5 MiB is `413`; the font file `ETag` is its SHA-256 |
| E14 | Saved manifest | B saves A's template. A edits it, unpublishes it, republishes it and deletes it, and B's manifest shows the new revision, `withdrawn`, `published` again and `deleted` in turn |

The cross-repository check an earlier draft proposed is replaced by the Playwright suite below, which exercises the real client against a live container on every pull request.

### Frontend end-to-end tests (Playwright)

These tests drive the real React app in Chromium against the real `server/` container and a real PostgreSQL. Only the desktop side is replaced: a fake agent stands in for the Rust IPC commands. They cover sign-in, template sync across two PCs, conflicts, versions, community, profiles, fonts and account preferences, which are exactly the features that move to the server.

**Out of scope: printing.** A browser cannot drive the Windows spooler, headless Edge, USB, Bluetooth or a printer on a LAN, so no end-to-end test prints. The same goes for printer setup and transports, the queue and print worker, the local REST API and deep links. They stay covered by the Rust tests in "Local agent tests" below and the manual hardware checklist. The suite does open the Print page and fills in its form, but never presses the print button (F13).

#### Stack and layout

| Piece | Choice | Notes |
| --- | --- | --- |
| Runner | `@playwright/test`, Chromium only | Version not checked. `.gitignore` already lists `playwright-report` and `test-results`, but the repository has no Playwright dependency or config today |
| App under test | `pnpm dev` (Vite on port 1420, `strictPort` already set) | The app is served as a normal web page. Tauri's `isWebMode()` becomes false because the fake agent defines `__TAURI_INTERNALS__` |
| Service under test | The built `server/` image, or `node server/dist/server.js` against a Testcontainers PostgreSQL | `CORS_ORIGINS=http://localhost:1420`, low-cost argon2, high auth rate limit (see below) |
| Desktop side | A fake agent injected with `page.addInitScript` | Bundled to one JS file by esbuild in the global setup |
| Locators | `getByTestId` for everything | Playwright's default test-id attribute is already `data-testid` |
| Parallelism | `fullyParallel`, 4 workers in CI, one retry in CI | Each test creates its own users, so tests share no rows |
| Artifacts | Trace on first retry, screenshot on failure, HTML report uploaded by CI | |

```text
e2e/
  playwright.config.ts
  support/
    stack.ts            global setup: start PostgreSQL, run migrations, start the API, build the fake agent
    testids.ts          the registry of every test id the suite uses
    api.ts              typed helper on the generated client: register, sign in, create or edit data directly
    fixtures.ts         `pc()` opens a new browser context with its own fake agent; `signedInPc(user)`
    fakeAgent/          in-memory implementation of the IPC commands, persisted to localStorage
  tests/
    auth.e2e.ts  sync.e2e.ts  conflict.e2e.ts  versions.e2e.ts  community.e2e.ts
    library.e2e.ts  offline.e2e.ts  print-page.e2e.ts
```

Files are named `*.e2e.ts`, and the root Vitest config excludes `e2e/**`, so jsdom never loads a Playwright file.

#### The fake agent

Every IPC call in the app goes through `invoke`, which ends in `window.__TAURI_INTERNALS__.invoke(cmd, args)`. The fake agent defines that function and answers the commands the web UI uses:

- **Cache commands** (section 6): `cache_apply_changes`, `cache_list_dirty`, `cache_mark_pushed`, `cache_mark_conflict`, `cache_resolve_conflict`, `cache_get_sync_state`, `cache_clear_account`, with the same state transitions the Rust cache makes.
- **Local data commands:** templates, versions, settings, fonts, profiles, over the in-memory cache. One seeded printer, `E2E Label Printer`, so the Print page has something to select.
- **Print and jobs:** `print_html` returns a fake success and records the call so a test can assert it never happened. Nothing is rendered or sent anywhere.
- **Persistence:** the state is saved to `localStorage` on every command. A page reload then behaves like restarting the app, and a **second browser context is a second PC** with its own empty cache. That is how the suite proves a template reaches another computer.

Two guards keep the fake honest:

1. It is type-checked against the typed `agent` module (section 6), so a changed command signature fails the build.
2. A Vitest test, `src/test/agentContract.test.ts`, reads the command names the app calls and checks each one exists in the `generate_handler!` list of `src-tauri/src/lib.rs` and in the fake agent.

The cache semantics (what `cache_apply_changes` does to a dirty row, to a tombstone, to a stale cursor) are described once in `src-tauri/tests/fixtures/cache_cases.json`. The Rust tests and the fake agent's own Vitest tests both run those cases, so the fake and the real cache cannot drift apart silently. I have not verified the exact shape of Tauri's IPC object against the `@tauri-apps/api` version in `package.json`; the Phase 1 spike proves the shim with one command (section 12).

#### Test ids

`data-testid` is the primary locator. Rules:

- **Name:** kebab-case, `<area>-<element>`, for example `signin-submit`, `template-publish`, `sync-status`.
- **Dynamic ids use the server UUID, never the local integer id.** The local `templates.id` differs between PCs, so `template-row-<server_id>` is the only form that identifies the same template on both PCs.
- **State is an attribute, not text.** A status element carries `data-state`, for example `sync-status` with `data-state="synced|syncing|pending|offline|conflict"`, so tests do not depend on translated text.
- **Coverage:** every interactive control, every list row, every dialog and its buttons, and every status, error and notice element. Decorative icons get none.
- **Primitives pass it through.** `Button`, `Input` and the other components in `src/components/ui` already spread their props onto the element, so `data-testid` works on them without changes.
- **One registry.** `e2e/support/testids.ts` holds each id as a constant or small function. Tests import from it and never write a literal string.
- **Enforced in unit tests.** `src/test/testids.test.ts` fails if a registry id does not appear in `src/`, if a static id appears twice, or if an id is not kebab-case.
- **Policy for new UI.** A pull request that adds an interactive element adds its test id and registry entry.

Only two test ids exist in the app code today: `template-import` in `DesignerToolbar.tsx` and `class-warnings` in `ClassWarnings.tsx`. The others found under `src/` (`d`, `n`, `where`) sit inside Vitest files and are scaffolding for those tests. The minimum set below is added in Phase 1 for the screens the first specs use and completed in Phase 3. Names are proposals.

| Screen (file) | Test ids |
| --- | --- |
| Sign-in (`SignInScreen.tsx`) | `signin-form`, `signin-url`, `signin-handle`, `signin-password`, `signin-submit`, `signin-toggle-mode`, `signin-error`, `signin-notice` |
| Gate (`AuthGate.tsx`, `ServerUnreachableScreen.tsx`) | `gate-checking`, `gate-unreachable`, `gate-retry`, `app-shell`, `offline-banner` |
| Shell (`Layout.tsx`) | `nav-print`, `nav-designer`, `nav-templates`, `nav-printers`, `nav-history`, `nav-settings`, `sync-status`, `sync-now`, `sync-last-synced` |
| Templates (`Templates.tsx`) | `templates-tab-mine`, `templates-tab-saved`, `templates-tab-community`, `templates-search`, `templates-get-from-server`, `template-row-<id>`, `template-open-<id>`, `template-use-<id>`, `template-remove-<id>`, `community-card-<id>`, `community-save-<id>`, `community-preview-<id>`, `community-refresh`, `preview-dialog`, `preview-close` |
| Get from server (`GetFromServerDialog.tsx`) | `get-from-server-dialog`, `get-from-server-row-<id>`, `get-from-server-download`, `get-from-server-error` |
| Designer sync bar (`TemplateSyncBar.tsx`) | `template-state` (with `data-state`), `template-publish`, `template-unpublish`, `template-unpublish-confirm`, `template-sync-now` |
| Designer (`Designer.tsx`, `DesignerToolbar.tsx`) | `designer-name`, `designer-html-editor`, `designer-css-editor`, `designer-readme-editor`, `designer-save-version`, `version-label`, `version-list`, `version-row-<n>`, `version-restore-<n>`, `version-delete-<n>`, `version-diff-<n>` |
| Conflict dialog (new) | `conflict-dialog`, `conflict-keep-mine`, `conflict-take-server`, `conflict-keep-both` |
| Print form (`Print.tsx`) | `print-template-select`, `print-printer-select`, `print-profile-save`, `print-profile-state`, `print-submit` |
| Settings (`Settings.tsx`) | `settings-signed-in-as`, `settings-sign-out`, `settings-brand-name`, `settings-density`, `settings-logo-upload`, `settings-api-port`, `settings-font-upload`, `font-row-<id>`, `font-state-<id>`, `font-delete-<id>` |

Toasts come from `sonner`. I have not checked whether its options can carry a test id; the Phase 1 spike decides. If not, tests assert on the persistent status elements above instead of on toasts.

#### Isolation and data

- **One stack per run, one user per test.** Handles are `e2e_<run>_<n>`, so no test needs a database reset, and the suite never adds a test-only endpoint to the service.
- **Fast setup through the API, behavior through the UI.** `api.ts` registers users and creates templates directly on the generated client. The UI is used for the thing under test only.
- **Skip the login screen when it is not the subject.** `signedInPc(user)` writes `share_service_url` and `share_session_token` into the fake agent's settings before the app loads. Only `auth.e2e.ts` types into the sign-in form.
- **Rate limit.** All tests share one client address, so the stack runs with `RATE_LIMIT_AUTH_MAX=1000`. The `429` message in the UI is checked by answering that one request with Playwright's `route.fulfill`. The real limiter is tested in the backend workflow E8.
- **No sleeps.** Waits use Playwright's web-first assertions. Timers use `page.clock`: advancing five minutes triggers the background pull, and a `focus` event on `window` triggers the focus pull.

#### Workflows

| # | Workflow | What must hold |
| --- | --- | --- |
| F1 | Sign up and sign in | Register on the sign-in screen, reach the app shell. Wrong password shows the error and stays on the screen. A handle that differs only by case shows the "already in use" message (`409`). Sign out returns to sign-in. Sign in again |
| F2 | Session ends while working | Another client logs the user out through the API. The next sync gets `401`, the sign-in screen appears with the "session ended" notice, and the unsaved edit is still in the cache after signing in again |
| F3 | Create on PC A, appears on PC B | A creates a template. Its state is `pending`, then `synced` with no click. The server has it, private. PC B signs in and the template is in Templates after the first pull, with no "Get from server" step |
| F4 | Edit propagates | A edits the HTML and waits for `synced`. B receives a `focus` event and shows the new content. The Print page on B uses the new content without any Refresh |
| F5 | Delete propagates | A deletes the template. B's next pull removes it from the list |
| F6 | Conflict, three outcomes | A and B both edit offline, A pushes, B pushes: B gets `conflict` and the dialog. One run each for Keep mine (server revision moves past A's, A's edit is in history), Take server, Keep both (a second template appears) |
| F7 | Publish, find, save, withdraw | A publishes. B finds it in Community by search and sorts it, saves it, and sees it in Saved as read-only. A unpublishes and B's copy shows "Withdrawn by author" after the next pull. A republishes and it is available again |
| F8 | Version history on the server | A saves two labelled versions. B opens the Designer and sees both, restores the first (a new revision appears, nothing is lost), deletes the older one. The current version cannot be deleted |
| F9 | Printer profile follows the user | A saves a profile for `E2E Label Printer` on a template. B selects the same template and printer name and the profile's settings are applied. A printer name B does not have leaves the profile dormant |
| F10 | Fonts | A uploads a font in Settings. B shows it first as `downloading`, then `ready` once the file is in its cache. A deletes it and it disappears from B. A file with the wrong content is rejected with the inline error |
| F11 | Account preferences | Brand name and density set on A appear on B after a pull. `settings-api-port` set on A does not appear on B |
| F12 | Offline start and recovery | With a cache and a session, the API is made unreachable (`route.abort`) and the app reloads: it opens with `offline-banner`, templates are listed, `sync-status` is `offline`. Local edits show `pending`. The API comes back, the next pull succeeds and the edits are pushed. Without a cache the unreachable screen shows and Retry works |
| F13 | No network at print time | On the Print page, with request logging on, selecting a template and a printer and filling the form causes **zero** requests to the API. The test never presses `print-submit` |
| F14 | First sync of a migrated install | The fake agent starts with local-only templates and one template whose server copy changed. The "back up N templates" dialog appears (question 18, answered: ask once, allow decline). After confirming, the local-only ones are pushed private, and the changed one shows `conflict` instead of being overwritten |

Roughly 14 specs and 20 to 25 test cases; the target is under 6 minutes on 4 workers.

#### What the suite will not catch

The fake agent is not the Rust code. A bug in the real cache, in IPC argument names that the type check cannot see, or in the packaged Tauri build is not found here. The Rust cache tests (Phase 3) and the shared cache-case fixtures cover the first; a short manual smoke test on the packaged app per release covers the rest.

### Local agent tests (Rust, Phases 0 and 3)

The print path stays in Rust, so its tests do too. Phase 0 adds, using the existing `src-tauri/tests` style:

- `get_job`, `reprint_job` and `retry_job` against an in-memory SQLite (fails today because of P1).
- `sync` as a version author on a real schema (P2).
- A worker test: a `queued` job and a `queued` batch end as `success` or `failed`, never stay `queued` (P3).
- A loopback TCP listener that receives a job sent to a raw-TCP printer, asserting ESC/POS, ZPL or TSPL bytes for those languages and PDF bytes only for `pdf` (P4).
- A local mock IPP server that answers HTTP `200` with an IPP error status; the job must be `failed` (P7).
- Rendering with no Edge available fails the job; it must never produce the stub PDF (P5).
- Two jobs for two printers render in parallel and each output contains its own HTML (P6).
- `data_url` pointing at `127.0.0.1` or a private address is refused (P13).
- A check that `openapi.rs` lists the same routes and required fields as the router.

Phase 3 adds tests for the local cache, run with the cases in `src-tauri/tests/fixtures/cache_cases.json`:

- `cache_apply_changes` writes its records and the new cursor in one transaction; a simulated failure leaves both unchanged.
- A pulled change does not overwrite a `dirty` row; it marks the row `conflict` when the server revision moved.
- A deleted template stays as a tombstone until `cache_mark_pushed` confirms it; a `delete` record from the server removes a `synced` row.
- After `reset`, a `synced` row missing from the full pass is removed and a `dirty` row is kept.
- `cache_clear_account` empties the cache when the account or server URL changes.
- `print_html` for a cached template succeeds with no network and never starts a sync, and a printed saved copy queues a use count that a later sync sends.
- Migrating an old database keeps every template, version, job and printer, and turns `remote_id` into `server_id`.

Real printers, the USB transport and Android cannot be tested in CI. Keep a one-page manual checklist for them, run once per release on a Windows machine with a thermal printer and a network printer.

### Test database isolation and fixtures

- **One container per test run.** A Vitest global setup starts `postgres:16` with Testcontainers, applies migrations once with `prisma migrate deploy`, and keeps that database as a template.
- **One database per Vitest worker,** created with `CREATE DATABASE ... TEMPLATE ...`, so files can run in parallel without sharing rows.
- **Truncate between tests.** `TRUNCATE ... RESTART IDENTITY CASCADE` in `beforeEach`. I do not recommend wrapping each test in a transaction that rolls back, because the app opens its own connections and the concurrency tests above need real commits.
- **Fast hashing in tests.** The argon2 cost is an environment variable (section 12), set low in tests. Real-cost hashing is exercised by one dedicated test.
- **Factories, not shared seed data:** `buildUser`, `buildTemplate` and `buildPublishedTemplate`, each with sensible defaults and overrides. A `signIn(app, handle)` helper registers through the real route and returns a token, so tests also cover the auth path.
- **Determinism.** A fake `Clock` for unit tests; in integration tests, assert on ordering and relative times, never on `now()`.
- **Migration fixture.** A committed SQL file that builds a small v1 database (two users, one scrypt hash, one expired and one live session, private and published templates, a saved row). The test builds the SQLite file from it, so no binary is in git.

### CI

New jobs in the existing `ci.yml`, written in its style (pnpm 10, Node 22, `--frozen-lockfile`, `permissions: contents: read`, a concurrency group that cancels superseded runs):

| Job | Runs | Blocks merge |
| --- | --- | --- |
| `check` | `pnpm lint`, `pnpm typecheck`, `pnpm test:unit` | Yes |
| `integration` | `pnpm test:int` on a runner with Docker (GitHub's `ubuntu-latest` has it) | Yes |
| `openapi` | `pnpm openapi:generate` then `git diff --exit-code openapi/openapi.json` | Yes |
| `e2e` | `docker compose up -d --build --wait`, then `pnpm test:e2e` | Yes on `main` and release branches; may be label-triggered on pull requests if it is slow |
| `image` | Builds the Dockerfile and starts it to confirm the health check passes | Yes |
| `app-e2e` | `pnpm exec playwright install --with-deps chromium`, then `pnpm e2e`; uploads the HTML report and traces when it fails | Yes |

In `web-check`, regenerate `src/lib/api/schema.d.ts` with `pnpm gen:api`, fail on a diff, and run the type check, so a contract change that breaks a call site fails the pull request that made it. The job that runs `cargo test --manifest-path server-legacy/Cargo.toml` stays until the Rust share server is retired.

Coverage: no global percentage gate at first. Set one on `src/domain/` only (for example 90% of lines), since that is where the rules live.

## 12. Phased implementation roadmap

Phases are ordered by user impact and risk. Sizes are relative (S, M, L), not calendar estimates; I have no velocity data for this team. Bug ids (P1 to P18) refer to section 3.

**Order and overlap.** Phase 0 first. If two people are available, Phases 1 and 2 touch no Rust and can run beside items 0.3 to 0.6. Only item 0.2 must finish before Phase 3: Phase 3 changes the local schema and needs the single migration path from 0.2. The end-to-end harness (Phase 1) and the test ids can be built by a third person at any time after the Phase 1 spike.

| Phase | Theme | Size | Depends on |
| --- | --- | --- | --- |
| 0 | Fix the Rust app: local database, print path, local API | L | None |
| 1 | `server/` foundation, accounts, change sequence, and the end-to-end harness | M | None (spike first) |
| 2 | Templates, versions, community, saved, delta sync, and data migration | L | Phase 1 |
| 3 | App switch: local cache, sync engine, typed client, offline start, e2e suite, cutover | L | Phase 2, item 0.2 |
| 4 | Profiles, sample datasets, account preferences and fonts (server and app) | M | Phase 3 |
| 5 | Optional: print history sync | Not designed | Deferred on 2026-10-20 (section 13, question 10) |

### Phase 0: Fix the Rust app — complete (2026-10-20)

| Item | Bugs | Deliverable | Done when |
| --- | --- | --- | --- |
| 0.1 CI that tells the truth (S) | none | A CI job that runs `cargo test --manifest-path server/Cargo.toml` (the path changes to `server-legacy/` in Phase 1). Failing tests for P1 and P2 written first | The server's 22 tests run on every pull request; the new P1 and P2 tests fail on the current code |
| 0.2 Local database (M) | P1, P2, P11 | The shared job column list no longer ends in `ORDER BY`, so `get_job`, `reprint_job` and `retry_job` work. One migration lets `template_versions.created_by` accept `sync`; SQLite cannot alter a `CHECK`, so this is a table rebuild that must keep existing rows. One schema path instead of three. One reused connection with WAL and a busy timeout | The Rust tests for those commands and for `sync` pass; an old database file upgrades with no data loss; Refresh from server saves a version |
| 0.3 Print correctness (M) | P5, P6, P7, P14, P15 | No stub PDF: a missing or failing Edge fails the job. A unique render file per job. The IPP response status is read, and the printer path is configurable. A job row exists from the start with real `started_at`. A decision on one template engine (section 13, question 13) | The tests in section 11 for P5, P6, P7 and P15 pass; a job shows as running while it runs |
| 0.4 Queue and batch worker (L) | P3, P8 | One worker takes `queued` jobs and batches through `run_print` and the per-printer permit. Reprint, retry, batch and `POST /v1/print/batch` all use it. The printer key ignores case. REST batches store each record's data and enforce the 5,000 cap | A queued job or batch always ends `success`, `failed` or `cancelled`; batch `done` and `failed` counters move |
| 0.5 Local API hardening (M) | P12, P13 | `scopes`, `allowed_ips` and `last_used_at` enforced. Idempotency made atomic: the key is recorded before printing, under a unique index. `callback_url` either implemented or rejected with `400`. `openapi.rs` matches the router. `data_url` limited to `http` and `https`, with loopback, link-local and private addresses refused after DNS resolution and again on each redirect | Two simultaneous requests with one key print once; the loopback and private-address tests pass |
| 0.6 Command languages (L, needs hardware) | P4 | Dispatch on `printers.language`: ESC/POS, ZPL, TSPL, CPCL, raster and PDF each take their own path | Byte-level loopback tests pass in CI; the manual checklist passes on one ESC/POS printer and one ZPL or TSPL printer |

Also in Phase 0: correct the documentation items in P17, and delete the dead code listed in section 3.

**Phase 0 exit criteria.** `cargo test` is green on Linux and Windows CI, the manual hardware checklist passes, and a patch release of the app is tagged with a changelog entry.

**Marked complete 2026-10-20.** Items 0.1 to 0.6 and the P17 side mandate have all landed on the `refactoring` branch (PR #16), green on Linux and Windows CI with 209 tests, including the byte-level loopback tests for item 0.6. The manual checklist now lives in [`docs/HARDWARE_CHECKLIST.md`](docs/HARDWARE_CHECKLIST.md) and runs before each release; the patch release is the next release step.

### Phase 1: `server/` foundation, accounts, and the e2e harness

Start with a one-day spike, because five assumptions are untested:

1. One route, one Zod schema, and the generated OpenAPI 3.1 document validates; versions are pinned.
2. `argon2` installs and runs on the chosen Docker base image (section 13 lists the alternative if it does not), and the pnpm build allow-list for `argon2`, `prisma` and Playwright is right.
3. A real password hash from the Rust server verifies in Node. Those are scrypt PHC strings whose parameters are stored in the string. If they use the Rust crate's defaults, one verification needs about 128 MiB, above Node's default `scrypt` memory limit, so the limit must be raised and the throttle must stay in place. Confirm on a real hash.
4. The Tauri IPC shim works: the fake agent answers `get_setting` through `window.__TAURI_INTERNALS__` and the app, served by Vite, renders the sign-in screen.
5. The per-user change sequence (section 7) gives gap-free cursors under parallel writers. A test with 20 concurrent writers must show that a reader never skips a record.

| Deliverable | Notes |
| --- | --- |
| Repository move | `git mv server server-legacy`; update `ci.yml`, `README.md` paths; the old compose file moves with it. The old server keeps running unchanged |
| `server/` scaffold from section 5 | `server.ts`, `app.ts`, `config.ts`, the three layers, the import rule enforced by a lint or dependency check chosen in the spike |
| Workspace wiring | `pnpm-workspace.yaml`, Vitest exclude, Biome includes, root `docker-compose.yml` and `env.example` (section 5) |
| Cross-cutting plugins | Error envelope and request ids, helmet, CORS allow-list, rate limit, body limits, graceful shutdown |
| Prisma 7 setup | `prisma.config.ts`, generator output path, `User`, `Session` and `UserSync` models, first migration |
| Endpoints 1 to 4 and 16 | Register, login, logout, me, health |
| Session cleanup | On startup and hourly, no job queue |
| Packaging | Multi-stage `Dockerfile` with a non-root user and a health check on `/v2/health`; `docker-compose.yml` with PostgreSQL and a data volume |
| E2E harness | `e2e/` package, global setup that starts PostgreSQL and the service, the fake agent with the commands the sign-in and shell screens need, `fixtures.ts`, `api.ts`, `testids.ts` |
| Test ids, first pass | Sign-in, gate and shell screens (section 11), `testids.test.ts`, `agentContract.test.ts` |
| One smoke spec | The app starts, the gate shows `gate-unreachable` when the API is down and `signin-form` when it is up. The full F-series arrives with the app switch in Phase 3, because the app still speaks `/v1` until then |
| CI | The jobs in section 11, and a committed `openapi/openapi.json` |
| README | Every command and variable in this section |

**Done when:** the ported auth characterization tests pass; E1 and E8 pass; `docker compose up` gives a healthy service; CI is green with the drift check proven by one deliberate failing change; no Prisma type is imported outside `infra`; login no longer blocks other requests (P9); the smoke spec passes in CI.

### Phase 2: Templates, versions, community, saved, delta sync, migration

| Deliverable | Notes |
| --- | --- |
| `Template`, `TemplateVersion`, `SavedTemplate`, `Tombstone` models and migration | Section 7 |
| Endpoints 5 to 15 | Templates, publish, community, saved, use (with `count`). Section 8 |
| Mandatory revisions | `if_revision` on update, `428` when missing, idempotent replay, `ETag` and `If-None-Match` on `GET` (sections 8 and 9) |
| Endpoints 17 to 20 | Version list, read, restore, delete. Every content-changing `PUT` appends a version; autosaves are pruned to the latest 50 per template |
| Endpoint 21, `GET /v2/sync/changes` | Template records and tombstones, byte-budgeted pages, `reset` for stale cursors |
| Endpoint 22, saved manifest | Revision and state (`published`, `withdrawn`, `deleted`) of every saved template |
| Server-side remote-reference check and size caps | Closes P10 |
| Pagination, escaped search, tie-broken sorting, RFC 3339 timestamps, `null` for private | Closes P16 |
| Characterization suite and API workflows E2 to E7, E10 to E12 and E14 | Section 11 |
| Import script with `--dry-run` | Section 7. Written and rehearsed on a copy of the real database (E9) |
| `openapi.json` and generated `schema.d.ts` | Both committed; no copying between repositories (section 10) |

**Done when:** all template, community, saved, version and sync operations are in the OpenAPI document with examples; every v1 behaviour in the characterization suite either passes or is listed as a deliberate v2 change; the rehearsal's row counts match the source; an old password and an old session token both work against the imported data; E10 shows a deleted template and a changed template arriving through one cursor, and a cursor survives a restart of the service.

### Phase 3: App switch, local cache, and cutover

Work in `src/` and `src-tauri/`, then production.

| Deliverable | Notes |
| --- | --- |
| Typed client | `pnpm gen:api`, `openapi-fetch`, one middleware that adds the bearer token and ends the session on `401`. Replaces `RemoteTemplate`, `PublishPayload` and `RemoteTemplateSummary` in `src/lib/share/client.ts` |
| Error envelope handling | A typed `ApiError` with `code` and `request_id`; the unreachable-server screen unchanged |
| Local schema migration (Rust) | The columns and the `sync_state` table in section 6, added through the single migration path from 0.2. Existing `remote_id` becomes `server_id`. Local-only templates get a new `server_id` and the state `dirty` with no server copy |
| Cache commands (Rust) | Section 6, with tests: `cache_apply_changes` is atomic with the cursor; a dirty row survives a pull; a tombstone is removed only when the server confirms; clearing the account wipes the cache. Cases live in `cache_cases.json` and run in Rust and against the fake agent |
| Sync engine (`src/lib/sync/`) | Pull, push, triggers, backoff, the `reset` pass, queued use counts |
| Adoption pass for existing installs | On first sync, a local row whose content matches the server is `synced`; one that differs is a `conflict`, not an overwrite; a local-only template is pushed as private after a one-time confirmation dialog (question 18, answered) |
| UI | Sync status chip and staleness, conflict dialog, "Save version" through the server, version panel reading from the server, the sync bar reduced to Publish, Unpublish and Sync now |
| Offline start | The gate opens from the cache when the server is unreachable (section 6) |
| Entity types de-duplicated, typed `agent` module | Closes P18; `invoke<any>` removed in the Designer |
| Test ids, second pass | Every screen in the table in section 11 |
| Playwright suite | F1 to F8 and F12 to F14, running in CI |
| Cutover runbook | Put the Rust server in read-only mode, run the import, compare counts, change the server address, keep the old server stopped but intact for a rollback window, then delete `server-legacy/` and update the README and CHANGELOG |

**Done when:** the app builds against the generated types with no hand-written entity type for server data; a template created on one PC reaches another with no manual step; Publish and Unpublish work against the new service; printing a template with the network blocked works (Rust test and F13); the e2e jobs pass; production is on the new service and the rollback window has passed.

### Phase 4: Profiles, sample datasets, account preferences and fonts

A vertical slice: server and app together, because each piece is small.

| Deliverable | Notes |
| --- | --- |
| Models and endpoints 23 to 32 | `SampleDataset`, `PrinterProfile`, `UserSetting`, `Font`, `FontFile`; sync records for each |
| Settings audit | Every key in the local `settings` table is classified as device (stays) or account (moves). The allow-list is enforced on the server |
| Profiles | Existing local profiles are uploaded keyed by printer name (question 20, answered); `list_profiles`, `save_profile`, `delete_profile` become cache writes |
| Fonts | Upload, magic-byte and size checks, background download with a SHA-256 check into the cache folder, `font-state-<id>` in Settings |
| Sample datasets | The Designer panel that saves and selects datasets, which has no persistence today |
| Account preferences | Density, brand name and logo through the cache |
| Playwright | F9 to F11 |

**Done when:** a profile, a dataset, a font and a preference created on one PC show up on another; a device setting does not; and a font file with the wrong content is refused.

### Phase 5: Print history sync (optional, not designed)

Only if signed off. It raises privacy questions (rendered HTML can contain customer data) that this plan does not answer.

### Dependencies

Versions were read from the npm registry on 2026-10-20; nothing was installed. Names are the proposal; exact pins are fixed in the Phase 1 spike.

| Package | Role | Current on npm |
| --- | --- | --- |
| `fastify` | HTTP server | 5.12.7 |
| `fastify-type-provider-zod` | Zod to validation and OpenAPI; needs Zod >= 4.1.5 | 7.0.0 |
| `@fastify/swagger`, `@fastify/swagger-ui` | OpenAPI document and `/docs` | 9.9.2, 6.1.2 |
| `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit` | Security headers, CORS allow-list, throttling | 13.2.0, 11.3.1, 11.2.1 |
| `zod` | Schemas | 4.6.7 |
| `@prisma/client`, `@prisma/adapter-pg`, `pg` | Database access; Prisma 7 needs the adapter and the driver | 7.10.1, 7.10.1, not checked |
| `argon2` | Password hashing | 0.45.1 |
| `prisma` (dev) | CLI and migrations. Pin 7.x: the `latest` tag is currently 8.0.0-rc.23 | 7.10.1 |
| `typescript`, `tsx` (dev) | Compiler and dev runner | 5.x chosen; 7.0.2 is `latest`; tsx 4.23.15 |
| `vitest`, `testcontainers`, `@testcontainers/postgresql` (dev) | Tests | 5.0.5, 12.2.1, 12.2.1 |
| `@biomejs/biome`, `@types/node`, `@types/pg`, `dotenv` (dev) | Lint and format, types, env loading for the Prisma CLI | App uses `^2.5.15` for Biome; others not checked |
| `openapi-typescript` (app, dev), `openapi-fetch` (app) | Generated types and typed client | 7.13.0, 0.17.0 |
| `@playwright/test`, `esbuild` (e2e, dev) | Browser tests; bundling the fake agent | Not checked. esbuild is already in the workspace through Vite |

### Configuration and environment variables

Nothing is loaded automatically, which matches today's `env.example`. In development use Node's `--env-file` flag. The Prisma 7 CLI does not read `.env` by itself, so `prisma.config.ts` loads `dotenv`. One vendor guide says Prisma 7.10 and later name this file `prisma7.config.ts`; confirm in the spike.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | Environment |
| `HOST` | `127.0.0.1` (the image sets `0.0.0.0`) | Bind address. The Rust server always bound `0.0.0.0` |
| `PORT` | `3001` | Same default as the Rust server |
| `DATABASE_URL` | required | `postgresql://user:password@host:5432/printninja` |
| `LOG_LEVEL` | `info` | pino level |
| `CORS_ORIGINS` | required | Comma-separated allow-list, including `tauri://localhost` and `http://tauri.localhost`, and `http://localhost:1420` in development and e2e |
| `TRUST_PROXY` | `0` | Number of proxy hops to trust for client IPs |
| `SESSION_TTL_DAYS` | `30` | Session lifetime |
| `SESSION_CLEANUP_MINUTES` | `60` | Expired-session purge interval |
| `RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_AUTH_WINDOW_SECONDS` | `10`, `300` | Login and register limit, per IP and per handle |
| `RATE_LIMIT_MAX` | `120` per minute | Everything else, per token or IP |
| `ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM` | chosen in the spike | Lowered in tests |
| `DOCS_ENABLED` | `true` | Serve `/docs` and `/openapi.json` |
| `SYNC_TOMBSTONE_DAYS` | `90` | How long deletions stay answerable by a cursor |
| `SYNC_PAGE_BYTES` | `8388608` | Byte budget of one `GET /v2/sync/changes` page |
| `AUTOSAVE_KEEP` | `50` | Autosave versions kept per template |
| `FONT_MAX_BYTES`, `FONTS_PER_USER_MAX` | `5242880`, `50` | Font size and count caps |
| `SAVED_PER_USER_MAX` | `1000` | Saved-template cap |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `SHARE_BIND` | none | Read by `docker-compose.yml` only; `SHARE_BIND` keeps the name operators already know |

### Commands that will eventually be needed

Documentation only; none has been run. Script names are proposals. Server scripts run inside `server/`, or from the root with `pnpm --filter server <script>`.

| Purpose | Command |
| --- | --- |
| Install | `pnpm install --frozen-lockfile` |
| Generate Prisma client | `pnpm prisma generate` |
| New migration, development | `pnpm prisma migrate dev --name <name>` |
| Apply migrations, CI and production | `pnpm prisma migrate deploy` |
| Run in development | `node --env-file=.env` with `tsx watch src/server.ts`, wrapped as `pnpm dev` |
| Build and start | `pnpm build`, `pnpm start` |
| Quality | `pnpm lint`, `pnpm typecheck` |
| Tests | `pnpm test:unit`, `pnpm test:int`, `pnpm test:e2e`, `pnpm test` |
| OpenAPI | `pnpm openapi:generate`, `pnpm openapi:check` (the drift check) |
| Import from the Rust server | `pnpm import:v1 --source <file> --dry-run` |
| Run the stack | `docker compose up -d --build --wait` |
| Regenerate the app's API types (root) | `pnpm gen:api`, which runs `openapi-typescript server/openapi/openapi.json -o src/lib/api/schema.d.ts` |
| App end-to-end tests (root) | `pnpm e2e`; `pnpm e2e --ui` while writing specs |
| Browser for the e2e tests | `pnpm exec playwright install chromium` |

## 13. Decisions, trade-offs and answered questions

### Key decisions

| # | Decision | Why | What it costs |
| --- | --- | --- | --- |
| D1 | Printing, printers, transports, the queue, batches, job history, the local API with its keys, and deep links stay in the Rust agent; the hosted API never prints | Every print step needs the Windows spooler, Edge, USB, Bluetooth or a private network (section 2) | Two codebases to maintain, and the worst bugs (P1 to P8) are fixed in the one this plan does not replace |
| D2 | Fastify 5 | Validated routes, generated OpenAPI and `inject()` testing with the least ceremony; runs where Prisma runs best | Hono would be smaller; Fastify's plugin model is one more thing to learn |
| D3 | PostgreSQL in dev, CI and production | Concurrent writers, `timestamptz`, no global lock (P9, P11) | One more container than a SQLite file |
| D4 | New `/v2` contract: error envelope, `Page<T>`, separate publish and unpublish | The v1 client reads `err.error` as a string and would show `[object Object]`; the `publish` flag has three meanings today | The app's share client changes in Phase 3 |
| D5 | Zod schemas in `http/schemas` are the single source of truth; OpenAPI and the frontend types are generated from them | One place to write the contract, with CI to catch drift | The Zod 4 requirement pins the stack to current majors |
| D6 | Repository interfaces in `domain/ports.ts`, hand-wired in `app.ts`, no DI container | Business rules and unit tests never touch Prisma; the brief asks for no unnecessary abstraction | A second implementation (the fake) to keep in line, guarded by the contract suite |
| D7 | Prisma 7.10.x with `@prisma/adapter-pg`, not the 8.0 release candidate | `latest` on npm is an RC; Prisma 7 needs the adapter and a config file anyway | Revisit when 8 is stable |
| D8 | Sync stays client-driven: the app pushes and pulls, the server never calls a device | Matches `share/sync.ts` and `MIGRATION_PLAN.md`; printing works with no network | The server cannot push updates to a PC, so a PC learns of a change at its next pull (within 5 minutes while the app is open) |
| D9 | `snake_case` JSON, as today | Smallest change for the Rust structs and the current client | Not idiomatic TypeScript, so generated types use snake_case property names |
| D10 | `PUT` never changes visibility; a created template is private; omitted optional fields keep their stored value | v1 publishes a new template when the flag is omitted and wipes `summary` and `readme` (P16) | A behaviour change from v1, covered by the characterization suite |
| D11 | `400` for validation, `413` for a field over its size cap or a body over the limit; no `422` | Clients already handle `400`; one code per cause | v1 returned `400` for size caps |
| D12 | Offset pagination | Enough at this size; simplest | Cursors are the upgrade if a list reaches tens of thousands of rows |
| D13 | argon2id for new hashes; scrypt hashes verified once and rehashed at next login | Keeps every existing account working without a reset | Two verifiers live in the code until the last scrypt hash is gone |
| D14 | Opaque database-backed sessions, not JWTs | Logout and expiry must take effect at once, and existing tokens (stored as SHA-256) must stay valid | One database read per request |
| D15 | In-memory rate limiter | No extra service | One instance only; a second instance needs a shared store |
| D16 | The local REST API keeps its `/v1` wire shape and its `{ "error": "text" }` errors | Automation scripts already depend on them | The two APIs have different error formats, documented in section 8 |
| D17 | The server is the source of truth for everything the user owns; the Rust app is a cache that prints from its local copy | A cache that can ask "what changed" ends manual Save and Refresh and the risk of printing a stale template (the risk `MIGRATION_PLAN.md` accepted) | A sync engine, a local schema migration, a conflict dialog and a status UI to build and test |
| D18 | One delta endpoint, `GET /v2/sync/changes`, driven by a per-user sequence taken under a row lock, plus tombstones | `updated_at` and global sequences can make a reader skip a row (section 7); one cursor covers every entity type | One user's writes queue briefly; tombstones must be purged; a stale cursor needs a reset pass |
| D19 | `revision` is mandatory on updates and counts content changes only; a push carries `if_revision`; an identical replay is accepted | A background push must never overwrite another PC silently; a lost response must not look like a conflict; a visibility change elsewhere must not block a body push | `428` for clients that forget the field; a conflict dialog |
| D20 | Version history lives on the server from Phase 2; the `sync` author is dropped | History has to be shared by every PC, and it removes the cause of P2 | Each content change stores up to 832 KiB; autosaves are pruned to 50 per template |
| D21 | Font bytes live in PostgreSQL behind a `FontStore` port | One system to back up; 5 MiB and 50 fonts per user is small | The database grows; swap the store if it hurts |
| D22 | The service lives in `server/` of this repository; the Rust share server moves to `server-legacy/` until cutover | A contract change and the app change that follows travel in one pull request; no cross-repository release step | One repository, two toolchains and a larger CI. This replaces the earlier separate-repository plan |
| D23 | A Playwright suite in `e2e/` with a fake desktop agent; no printing tests | A browser cannot print; the fake agent makes two-PC tests fast and deterministic | The fake can drift from Rust; the agent type, the contract test and shared cache-case fixtures contain that |
| D24 | `data-testid` is the primary locator; dynamic ids use the server UUID; one registry in `e2e/support/testids.ts` | Selectors independent of text and language; the same id on every PC | Every new interactive element must ship its id |

### Trade-offs worth stating plainly

- **A new backend will not make printing better.** It removes the share server's defects (P9, P10, P16) and gives the app a typed contract. The defects users feel are in Phase 0.
- **Prisma versus the "database-independent" requirement.** Prisma has one provider per schema, so changing databases means changing the provider and re-running migrations. Independence here comes from the repository interfaces, which keep that change inside `infra/prisma`.
- **Typed client versus effort.** Generating a client from OpenAPI costs two CI checks: one for the contract file and one for the generated types. The alternative, hand-written types on both sides, is what produced P18.
- **A real cache costs more than two buttons.** It needs a sync engine, a local migration, conflict handling and a status display. In return, the manual Save and Refresh steps go away, and so does the "refresh before printing" habit that `MIGRATION_PLAN.md` listed as a risk.
- **Strict layering for about 15 endpoints.** Three layers and a fake per port is more than a tiny service needs. I kept it because the brief asks for business logic independent of the database, and because it is what makes the unit tests fast. Everything beyond that (events, a unit of work, a service bus) is deliberately left out.

### Questions: all answered on 2026-10-20

Every question this plan left open now has an answer and nothing blocks Phase 1. Rows marked **Decided** were answered directly by Rafi; the others were accepted as the recommendation given here. Two answers changed a recommendation: there are no released `/v1` clients, so no `/v1` adapter is needed (question 2), and TLS is terminated by an existing reverse proxy rather than a new Caddy (question 7).

| # | Question | Answer |
| --- | --- | --- |
| 1 | The sign-offs from the summary | **Decided:** all seven approved as recommended — hardware boundary, PostgreSQL, `/v2` contract, Phase 0 first, server as source of truth with delta sync, and the Playwright suite with its fake agent; print history sync deferred (section 1). |
| 2 | Do released apps depend on `/v1`? | **Decided: no.** Verified in this repository: tags `v1.0.1`–`v1.0.6` exist (`v1.0.6` is `origin/main`) and their `src/lib/share/client.ts` calls `/v1/auth/*`, `/v1/templates*` and `/v1/saved*`, but these are internal/dev tags never distributed to users. **No `/v1` adapter** for cutover; `/v2` is a clean break. Revisit before any public release. |
| 3 | Who may register? | **Decided:** keep registration open — the service is an internal tool. Add an invite code only if it ever goes public. |
| 4 | Account recovery and deletion | **Decided:** accept as-is for an internal tool (accounts have no email, so recovery is impossible today). Add password recovery and account deletion before any public launch. |
| 5 | Edit conflicts | Yes: `revision` and `if_revision` are mandatory from Phase 2, conflict dialog in Phase 3. `MIGRATION_PLAN.md`'s "last push wins" is rejected because background pushes would silently lose edits. |
| 6 | Copy a community template to edit | Not in the first release. |
| 7 | Hosting and HTTPS | **Decided:** TLS is terminated by the existing reverse proxy / load balancer; no Caddy is added. Deployment sets `TRUST_PROXY` to that proxy's actual hop count (1 for a single proxy; the default stays `0` until then). `server/Caddyfile` is deleted as dead config (P17). |
| 8 | Use-count inflation | Rely on the general rate limit (`POST .../use` per token); add one count per user per template only if the number starts to matter. |
| 9 | How a saved copy shows as withdrawn | Yes: the saved manifest reports an explicit `published` / `withdrawn` / `deleted` state, while `GET /v2/saved` keeps the v1 behaviour. |
| 10 | Print history sync (Phase 5) | **Decided: deferred.** Rendered HTML can contain customer data; the plan works without it. Stays optional and undesigned. |
| 11 | Typing the IPC commands | Hand-written typed `agent` module first; evaluate `tauri-specta` as a Phase 3 spike (it is unverified against this Tauri version). |
| 12 | Hardware for testing | **Decided:** all three devices are available — an ESC/POS printer, a ZPL or TSPL printer and a network printer. The full manual hardware checklist therefore runs for Phase 0 item 0.6 (P4, P7) and the USB transport. The Android bridge (a stub returning no printers) stays outside this plan. |
| 13 | One template engine | Print what the preview shows: one fixed helper set that both the preview's handlebars.js and the Rust renderer implement. No JavaScript runtime is added to the print path; P14 is fixed in the Rust renderer. |
| 14 | Which versions the server keeps | Every `manual` and `restore` version, plus the newest 50 `autosave` versions per template (`AUTOSAVE_KEEP=50`). |
| 15 | Toolchain timing | TypeScript 5.x and Prisma 7.10.x now; upgrade to TypeScript 7 and Prisma 8 after the first release. |
| 16 | Session token on the client | Scheduled separately: move the plain-text token in `settings` to a secure store. Tracked as a P17 follow-up, not part of this backend work. |
| 17 | Opening offline | Yes: with a cache and a stored session the app opens in offline mode when the server is unreachable at launch (section 6). |
| 18 | Uploading existing local-only templates | Ask once with a dialog that says how many templates will be pushed, and let the person decline. |
| 19 | Automatic push or explicit Save | Push dirty edits automatically about 3 seconds after the last change; "Save version" stays the explicit action that records a labelled version; Publish stays explicit. |
| 20 | How a profile names its printer | Keyed by the lowercase printer name, as the local API already matches printers. Renaming a printer leaves its profile dormant. |
| 21 | Fonts on the server | **Decided:** accepted for an internal tool — private to the owner, never in published templates, 5 MiB and 50 per user, bytes in PostgreSQL. Font licences are re-checked before any public launch. |
| 22 | Where the sync engine runs | The frontend (`src/lib/sync/`) first; move it into Rust only if the local REST API must serve fresh data with no window open. |
| 23 | Which settings are account preferences | Allow-list starts with `ui_density`, `brand_name`, `brand_logo`; everything else stays local. A Phase 4 audit classifies the remaining keys in the local `settings` table. |
| 24 | Where the Playwright suite lives | `e2e/` at the repository root, Chromium only — it drives both the app and the service; moving it under `server/` would only change paths. |

### Out of scope

Microservices, message queues, a server-side cache or Redis, GraphQL, organisations or teams, server-side printing, end-to-end tests of printing, email, and any change to the Android print plugin.

### What I did not verify

- How real printers handle a RAW spooler job carrying PDF bytes, the USB transport, and the Android path. Not yet exercised, but the hardware (ESC/POS, ZPL/TSPL, network printer) is confirmed available per question 12, so Phase 0 item 0.6 and the manual checklist can run. Android still needs a device.
- Running anything. For this revision I read the code only. The package versions come from the earlier draft's npm lookup of 2026-10-20 and were not re-checked; I installed nothing, built nothing and ran no tests (the SQLite reproduction of P1 in section 3 comes from the earlier draft). P2 is read from the schema and the code, not from a failing run.
- That the chosen packages emit a valid OpenAPI 3.1 document together. Their declared peer ranges are compatible (section 4); the Phase 1 spike proves the rest.
- The parameters of the stored scrypt hashes, and the real volume of data to migrate.
- The shape of Tauri's IPC object (`window.__TAURI_INTERNALS__.invoke`) against the `@tauri-apps/api` version in `package.json`. The fake agent depends on it; Phase 1 spike item 4 proves it.
- That `sonner` toasts can carry a `data-testid`, that Playwright installs under the repository's pnpm build allow-list, and the exact allow-list names.
- The per-user change sequence under real parallel writers. The reasoning is in section 7; the Phase 1 spike item 5 tests it.
- Which keys the local `settings` table holds beyond those I found by reading `src/` and `commands/settings.rs`. Phase 4 audits them.
- I read `SignInScreen`, `AuthGate`, `TemplateSyncBar`, `GetFromServerDialog`, the share client and sync code, `Templates.tsx` button labels, and the font and profile commands. The test id lists in section 11 are proposals for the other screens, which I did not read line by line.
