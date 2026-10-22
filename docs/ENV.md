# Environment variables

Every variable the code actually reads, in one place. For copy-paste
defaults see `env.example` (repo root) and `server/env.example` (compose);
this file explains what each one does.

## Which file goes where

There is exactly one live env file: **`server/.env`** (next to
`server/docker-compose.yml`). Compose reads it on its own; local server
runs use `node --env-file=.env` from `server/`. There is intentionally
no root `.env`: Vite needs no variables, and dev scripts default
`BASE_URL` to `http://localhost:1420` when unset (set it in a root
`.env` you create yourself only to override that).

| Run | Env source |
| --- | --- |
| `docker compose up` (from `server/`) | `server/.env` (copy `server/env.example`) |
| Local server (`node --env-file=.env`, from `server/`) | `server/.env` |
| CLI scripts (`db:apply`, `db:import`, `openapi:generate`) | `server/.env`, loaded automatically (explicit env wins) |

Never commit any `.env` file (`server/.env` is gitignored).

## Database

The service stores everything in a SQLite-family database through Prisma
plus the `@prisma/adapter-libsql` driver adapter — the same code path for
every environment:

| Run | Database |
| --- | --- |
| `docker compose up` (from `server/`) | Bundled file (`file:/data/printninja.db` in the named volume), unless `DATABASE_URL` is set |
| Local server (`node --env-file=.env`, from `server/`) | `DATABASE_URL=file:./dev.db` (no token) |
| Production container | Turso Cloud (`DATABASE_URL=libsql://…` + `DATABASE_AUTH_TOKEN`) |

### `DATABASE_URL`

- `file:` — a local SQLite file. Relative paths resolve from the process
  working directory. Used for development, tests and the bundled compose
  volume. No token needed.
- `libsql://…` — a Turso Cloud database (e.g.
  `libsql://your-db.turso.io`). Requires `DATABASE_AUTH_TOKEN`. This is
  the production shape: no database container to run, backups and
  replication are the provider's job.

### `DATABASE_AUTH_TOKEN`

Turso auth token (`turso db tokens create <database-name>`). Required
exactly when `DATABASE_URL` starts with `libsql:` — the service refuses
to start otherwise, naming the field. Never commit it; rotate it like
any secret.

### Migrations

Author with `pnpm --filter server db:migrate` (Prisma Migrate against a
local file), apply with `pnpm --filter server db:apply`. The container
entrypoint applies pending migrations on boot (`RUN_MIGRATIONS=false`
skips it — set that on all but one replica). `prisma migrate deploy`
cannot reach a remote Turso database, so the boot runner
(`src/infra/db/migrate.ts`) executes the same `migration.sql` files
through the libSQL client instead; it fails fast if an applied
migration's file changed. Migrations are forward-only: back up before
deploying a release that carries one, and test the restore.

## Network

### `CORS_ORIGINS`
Comma-separated **exact-match** allow-list, no wildcards. Entries are
trimmed; at least one is required or the service refuses to start.
A missing origin makes the browser block the response, so the app's
origin must be listed:
- production desktop app: `tauri://localhost`
- dev app (Vite): `http://localhost:1420`
- Android build: `http://tauri.localhost`

Trim to `tauri://localhost` (plus the Android origin if you ship it) on
a production host.

### `HOST`
Address the server listens on. Keep `127.0.0.1` for local runs so the
server is not reachable from other machines. Compose overrides this to
`0.0.0.0` on its own.

### `PORT`
Port the server listens on inside the container/process. Default: `3001`.

### `SERVER_PORT`
Host port that compose publishes the API on. Default: `3001`.

### `TRUST_PROXY`
Reverse-proxy hops trusted when finding the client IP (the login
throttle keys on it). `0` means clients connect directly; any positive
value means one proxy on this host. See `server/src/app.ts`.

## Sessions

### `SESSION_TTL_DAYS`
How many days a session lasts. Default: `30`.

### `SESSION_CLEANUP_MINUTES`
How often, in minutes, expired sessions are deleted. They are also
deleted once at startup. There is no job queue. Default: `60`.

## Sync

### `SYNC_TOMBSTONE_DAYS`
How many days deleted-record markers (tombstones) are kept. The hourly
cleanup removes older ones. A sync cursor older than the oldest kept
tombstone answers `reset: true`. Default: `90`.

### `SYNC_PAGE_BYTES`
Byte budget for one page of `GET /v2/sync/changes`. A page also stops
at the record limit. One template can be ~832 KiB, so the byte budget
usually matters more than the count. Default: `8388608` (8 MiB).

## Rate limits

### `RATE_LIMIT_MAX`
Global limit: requests per minute per IP. Default: `120`. The container
e2e suite relaxes this (it shares one client address); the auth limiter
below always stays at production values.

### `RATE_LIMIT_AUTH_MAX` / `RATE_LIMIT_AUTH_WINDOW_SECONDS`
Stricter limit for register and login: attempts per IP and handle
within the window. Defaults: `10` per `300` seconds (5 minutes).
Exceeding it answers `429` with `Retry-After`.

## Password hashing (Argon2id)

OWASP baseline settings for new password hashes. Lower them only in
throwaway test environments — never in production. (Legacy `scrypt`
passwords still verify and are rehashed to `argon2id` on first login.)

- `ARGON2_MEMORY_KIB` — memory cost in KiB. `19456` is about 19 MiB.
- `ARGON2_TIME_COST` — number of passes. Default: `2`.
- `ARGON2_PARALLELISM` — parallel threads. Default: `1`.

## Docs and logging

### `DOCS_ENABLED`
Serve `/docs` and `/openapi.json`. Default: `false`; set `true`
explicitly for a dev/staging host that needs the browser UI.

### `LOG_LEVEL`
Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`.
Default: `info`.

## Dev scripts

### `BASE_URL`
Address of the running dev server for `scripts/capture-screens.mjs`.
Default: `http://localhost:1420` (the `pnpm dev` port).
