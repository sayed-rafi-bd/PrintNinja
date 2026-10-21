# Release Guide — PrintNinja

This guide explains how to version, sign, and ship a new PrintNinja release.

## Prerequisites
- **Windows**: Rust stable, Node 22+, Visual Studio Build Tools (MSVC), `pnpm`
- **Android**: JDK 17, Android SDK (34), NDK 27+, `cargo ndk`
- For signing locally: Windows code-signing certificate (`.pfx`) OR Android keystore

## 1. Bump version and tag

Run this from a clean `main` that is up to date with `origin`:

```bash
pnpm release patch          # 0.5.0 -> 0.5.1
pnpm release minor          # 0.5.0 -> 0.6.0
pnpm release major          # 0.5.0 -> 1.0.0
pnpm release 1.2.3          # exact version (must be higher than the current one)

pnpm release patch --dry-run   # show what would happen, change nothing
pnpm release patch --push      # also push main + the tag (starts the CI release)
```

(`pnpm release:patch`, `release:minor` and `release:major` are shortcuts.)

The script (`scripts/release.mjs`, needs only Node and git) updates every place CI's
`version-check` reads:
- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml` (`[package]` version)
- `src-tauri/Cargo.lock` (the crate's own entry)
- `src/pages/Settings.tsx` (the `"vX.Y.Z"` fallback literal)

Then it commits `release: vX.Y.Z` and creates an annotated tag `vX.Y.Z`. It refuses to run
if:
- you are not on `main` (CI rejects tags that are not on `main`),
- the working tree is not clean,
- local `main` is behind `origin/main`,
- the new version is not higher than the current one, or the tag already exists
  (locally or on `origin`),
- the five files above do not all agree on the current version.

Without `--push` nothing leaves your machine, and you finish with
`git push --atomic origin main vX.Y.Z`. To undo an unpushed release:
`git tag -d vX.Y.Z && git reset --hard HEAD~1`.

To rename the app, use the older script instead:
`./scripts/release.sh --name "NewName" --version 1.0.0 --tag` (needs bash, python3 and
GNU sed).

### Fixing out-of-sync versions

If `pnpm release` stops with `versions are out of sync before bumping`, the five files
above disagree about the current version (a file shown as `(not found)` means its version
could not be read). Bring them back in line with:

```bash
pnpm version:set 0.5.0           # set all five files to this version
pnpm version:set 0.5.0 --dry-run # show which files would change, change nothing
```

`scripts/set-version.mjs` only edits the files. It does not commit, tag or push, and it
does not run the release checks. Set it to the **current** version you want to release
from, then run `pnpm release` as usual. Do not set the new version first and then run
`pnpm release` with the same number: the release script requires the new version to be
higher than the current one. Review the result with `git diff` before you release,
because the release script refuses a dirty working tree, so commit the change first.

## 2. Sign app locally (for now)

### Windows (MSI)
Store your certificate as `scripts/certs/windows.pfx` (not committed).

```powershell
# Set environment variables (Git Bash / pwsh)
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content ./scripts/certs/windows-private.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "your-password"

# Build MSI only
pnpm tauri:build -- --target x86_64-pc-windows-msvc --bundles msi

# Optional: sign the resulting MSI with signtool
signtool sign /f ./scripts/certs/windows.pfx /p password /tr http://timestamp.digicert.com /td sha256 /fd sha256 src-tauri/target/release/bundle/msi/*.msi
```

### Android (APK / AAB)
```bash
# Set the keystore path
export ANDROID_KEYSTORE_PATH=./scripts/certs/android.keystore
export ANDROID_KEYSTORE_PASSWORD=secret
export ANDROID_KEY_ALIAS=printninja
export ANDROID_KEY_PASSWORD=secret

# Build arm64-v8a only (modern mobiles)
pnpm tauri android build --target aarch64

# Optional: for emulator testing, also build x86_64
pnpm tauri android build --target x86_64
```

## 3. Local-only signing in CI

By default, **CI does not sign anything**. Code signing is intentionally local-only for now. The GitHub Actions workflow only *builds* unsigned artifacts and uploads them as workflow artifacts. Distribute signed binaries from your local machine via the GitHub Releases page.

## 4. Trigger the CI release

```bash
pnpm release patch --push        # or run without --push and push by hand:
git push --atomic origin main v1.0.0
```

Pushing a `v*` tag runs the `CI` workflow (a `create` trigger cannot filter by tag, so it uses `push`).
Pushes and pull requests on `main` and `develop` run the checks only; `develop` never releases.

Checks (every push / PR):
- **web-check**: lint + type-check + vite build + vitest. Uploads `dist` once for the Rust jobs.
- **rust-check** (Linux): cargo fmt, clippy (`-D warnings`) and cargo test. All blocking.
- **rust-test-windows**: cargo test on Windows, blocking.

Release jobs (tags only):
- **version-check**: the tag must be `vX.Y.Z`, the tagged commit must be on `main`, and the tag
  must match `package.json`, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock` and `Settings.tsx`
- **windows-build**: MSI only (`--bundles msi`, output in `src-tauri/target/release/bundle/msi`)
- **android-build**: `aarch64` (arm64-v8a) unsigned APK + AAB
- **github-release**: creates a **draft** GitHub Release with the MSI/APK/AAB attached

The build jobs wait for every check and for `version-check`, so a failing Rust test blocks the release.

Artifacts are also kept as workflow artifacts for 30 days.

The `server/` share service is built, tested and drift-checked by CI
(`server-check`, `server-image`) but **not** deployed by any workflow.
It is deployed by hand, see section 7.

## Hardware checklist

Before publishing, run [`docs/HARDWARE_CHECKLIST.md`](HARDWARE_CHECKLIST.md) on
the Windows machine with the printers attached. CI mocks the wire and the IPP
responses; real printers, the Windows spooler and USB are only exercised there.

## 5. Publish

Open the draft release on GitHub. If you sign locally, replace the unsigned files with your signed builds, then publish.

## 6. Architecture targets summary

| Platform | CI bundle | Local signing | Architectures |
|---|---|---|---|
| Windows | MSI only | `signtool` with `.pfx` | `x86_64-pc-windows-msvc` |
| Android | arm64-v8a | Android keystore | `aarch64-linux-android` (x86_64 optional for emulator) |

## 7. Deploy the share service (`server/`)

The share service (accounts, publish, browse, save, sync for every PC) is the
TypeScript service in `server/` plus PostgreSQL 16. It is **not** part of the
tag release and no workflow deploys it; CI builds, tests and drift-checks it
on every PR, and you deploy it by hand.

### When to deploy
- First time, before anyone can sign in.
- When `server/` changes. The app only knows the service address, so an app
  release does not require a server deploy unless the `/v2` API changed. If it
  did, deploy the server first and keep the change backward compatible, because
  users update the app at different times.

### Migrating off the legacy Rust service (one time)
The pre-cutover service (`server-legacy/`, SQLite, `/v1`) is deleted from this
repository. To carry its accounts over: run the old server read-only, import
with `pnpm --filter server db:import` (rehearsed by E9 against a committed
fixture), compare template counts on both sides, then point the app at the new
address (Settings → Share, or the sign-in screen's server field). Keep the old
server stopped but intact until the rollback window passes.

### Deploy with Docker (recommended)
From `server/` (the stack lives next to the service):

```bash
cd server
cp env.example .env   # usable defaults; edit POSTGRES_PASSWORD for anything shared
docker compose up -d --build
```

What this sets up:
- `db`: postgres:16 on the named volume `printninja-pgdata`. The volume
  survives rebuilds and restarts, so accounts and everything they own are
  kept. Do not run `docker compose down -v` unless you want to delete them.
- `server`: the multi-stage image (node:22, non-root), which runs
  `prisma migrate deploy` on boot — the schema travels with the image, so a
  first-ever `up` lands healthy with no manual step.
- The service port publishes on `${SERVER_PORT:-3001}` (default 3001). Put
  your HTTPS reverse proxy in front: the app sends session tokens as Bearer
  headers, so plain HTTP must not be used outside a trusted network. The proxy
  should set `X-Forwarded-For` to the real client address, because the login
  throttle keys on it.

Check it:
```bash
docker compose ps                    # db and server should be "healthy"
curl http://127.0.0.1:3001/v2/health # 200
docker compose logs -f server
```

Then continue with "Verify" below (the app part is the same).

### Back up
PostgreSQL holds all accounts and everything they own. Dump it while the
service is running:

```bash
docker compose exec db pg_dump -U printninja printninja > printninja-$(date +%F).sql
```
Test a restore at least once (into a scratch database, not over the live one).

### Update and roll back
```bash
git pull
docker compose up -d --build        # rebuilds the image, migrates on boot, replaces the container
```
Migrations run forward on boot and are not undone by rolling back the image:
to roll back, check out the previous commit and rebuild, restoring the database
backup first if the schema changed between the two.

Do not change `POSTGRES_PASSWORD` on an existing volume: PostgreSQL sets the
password only at first init, so the server fails to log in (`P1000` in the
server log) while `db` stays healthy. To rotate the password, dump the
database, `docker compose down -v`, set the new password, boot, and restore
the dump.

### Without Docker: build and run
Prerequisites: Node 22, pnpm 10, and a reachable PostgreSQL 16.

```bash
pnpm install --frozen-lockfile
DATABASE_URL=postgresql://USER:PASS@HOST:5432/printninja \
  pnpm --filter server exec prisma migrate deploy
pnpm --filter server build
DATABASE_URL=postgresql://USER:PASS@HOST:5432/printninja \
  HOST=127.0.0.1 PORT=3001 node server/dist/server.js
```
Run it under a service manager so it restarts on failure. The service reads
environment variables only (see `env.example`); it loads no `.env` file by
itself. Put persistent storage under PostgreSQL (on an ephemeral disk, use a
managed database — every account is lost with the disk), and put a TLS reverse
proxy in front that sets `X-Forwarded-For`.

### Verify
```bash
curl https://your-host/v2/health          # 200
```
Then in the app open **Settings, Share**, enter the service address (for example
`https://share.example.com`), register, publish a template, and check it appears
in the **Templates, Community** tab.

### Back up (without Docker)
PostgreSQL holds all accounts and everything they own. Dump it while the
service is running:

```bash
pg_dump "postgresql://printninja:PASS@HOST:5432/printninja" > /backups/printninja-$(date +%F).sql
```
Test a restore at least once (into a scratch database, not over the live one).

### Update and roll back (without Docker)
1. Pull, rebuild (`pnpm --filter server build`), and run
   `prisma migrate deploy` against the live database (back it up first) —
   migrations are forward-only and never run twice.
2. Restart the service and run the checks above.
3. Rollback: check out the previous release and rebuild, restoring the
   database backup first if the schema changed between the two.

### What CI covers
Every PR builds the service image (`server-image`), runs its unit,
integration and container suites, and fails on OpenAPI drift
(`server-check`). Deploying remains a manual step: nothing pushes the
image or runs migrations against the live database.

## Clean up cache

```bash
cd src-tauri && cargo clean
pnpm store prune
```
