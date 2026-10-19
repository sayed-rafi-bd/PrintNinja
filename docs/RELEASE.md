# Release Guide — PrintNinja

This guide explains how to version, sign, and ship a new PrintNinja release.

## Prerequisites
- **Windows**: Rust stable, Node 22+, Visual Studio Build Tools (MSVC), `pnpm`
- **Android**: JDK 17, Android SDK (34), NDK 27+, `cargo ndk`
- For signing locally: Windows code-signing certificate (`.pfx`) OR Android keystore

## 1. Bump version + rename (optional)

```bash
# Bump patch and tag a release
./scripts/release.sh 1.0.0 --tag

# With new app name
./scripts/release.sh --name "PrintNinja" --version 1.0.0 --tag

# Just bump patch (auto-increments z)
./scripts/release.sh --bump --tag
```

The script updates:
- `src-tauri/Cargo.toml` (name, version)
- `src-tauri/tauri.conf.json` (productName, version, identifier)
- `package.json` (name, version)

Then commits and (optionally) tags.

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
git push origin main
git push origin v1.0.0
```

Pushing a `v*` tag runs the `CI` workflow (a `create` trigger cannot filter by tag, so it uses `push`):
- **web-check**: lint + type-check + vite build + vitest
- **rust-check**: cargo fmt (blocking), clippy and cargo test (advisory)
- **version-check**: the tag must match `package.json`, `Cargo.toml` and `tauri.conf.json`
- **windows-build**: MSI only (`--bundles msi`, output in `src-tauri/target/release/bundle/msi`)
- **android-build**: `aarch64` (arm64-v8a) unsigned APK + AAB
- **github-release**: creates a **draft** GitHub Release with the MSI/APK/AAB attached

Artifacts are also kept as workflow artifacts for 30 days.

The `server/` share service is **not** built, tested or deployed by this workflow.
It is deployed by hand, see section 7.

## 5. Publish

Open the draft release on GitHub. If you sign locally, replace the unsigned files with your signed builds, then publish.

## 6. Architecture targets summary

| Platform | CI bundle | Local signing | Architectures |
|---|---|---|---|
| Windows | MSI only | `signtool` with `.pfx` | `x86_64-pc-windows-msvc` |
| Android | arm64-v8a | Android keystore | `aarch64-linux-android` (x86_64 optional for emulator) |

## 7. Deploy the share service (`server/`)

The share service (community templates: accounts, publish, browse, save) is a
separate Rust binary. It is **not** part of the tag release or CI, and it is
versioned separately from the app. Deploy it by hand.

### When to deploy
- First time, before anyone can use the Community library.
- When `server/` changes. The app only knows the service address, so an app
  release does not require a server deploy unless the `/v1` API changed. If it
  did, deploy the server first and keep the change backward compatible, because
  users update the app at different times.

### Prerequisites
- A host that stays up, with a persistent disk.
- Docker with the Compose plugin (for the Docker route), or Rust (for the manual route).
- HTTPS in front of the service. The app sends session tokens as Bearer headers,
  so plain HTTP must not be used outside a trusted network.
- Manual route only: Rust stable on the build machine. `server/Cargo.lock` is
  lockfile version 4, which needs Cargo 1.78 or newer (the Docker build image
  already has a recent one).

### Deploy with Docker (recommended)
Files: `server/Dockerfile`, `server/.dockerignore` and `docker-compose.yml`.

```bash
git clone <repo> && cd PrintNinja && git checkout v2

# Listens on 127.0.0.1:3001. Put your own HTTPS reverse proxy on the same host in front:
docker compose up -d --build
```

What this sets up:
- The image is built in two stages and runs as a non-root user (`uid 10001`).
- The database file is `/data/printninja-server.db` inside the container, on the
  named volume `printninja-data`. The volume survives rebuilds and restarts, so
  accounts and templates are kept. Do not run `docker compose down -v` unless you
  want to delete them.
- The port is published on `127.0.0.1` only, so nothing outside the host can
  reach the plain HTTP service. A reverse proxy on the same host must forward to it
  and should set `X-Forwarded-For` to the real client address. Without a proxy,
  other machines cannot connect; the comment in `docker-compose.yml` explains how to
  open the port, at the cost of unencrypted traffic.
- The container has a health check on `/health`. See `docker compose ps`.

Check it:
```bash
docker compose ps                                  # printninja-server should be "healthy"
curl http://127.0.0.1:3001/health                  # ok
curl https://share.example.com/v1/templates        # JSON (through your proxy)
docker compose logs -f printninja-server
```

Then continue with "Verify" below (the app part is the same).

Back up (stop, copy, start, so the file is consistent):
```bash
docker compose stop printninja-server
docker run --rm -v printninja_printninja-data:/data -v "$PWD":/backup busybox \
  cp /data/printninja-server.db /backup/printninja-$(date +%F).db
docker compose start printninja-server
```
The volume name is `<project folder>_printninja-data`; check it with
`docker volume ls`.

Update and roll back:
```bash
git pull
docker compose up -d --build        # rebuilds the image and replaces the container
```
To roll back, check out the previous commit and run the same command, or keep the
previous image by tagging it before you rebuild
(`docker tag printninja-server:local printninja-server:prev`). The data volume is
not touched either way. As described below, a release that changes the database
schema needs a manual migration first.

### Without Docker: build
```bash
cargo build --release --manifest-path server/Cargo.toml
# binary: server/target/release/printninja-server
```
Copy that one file to the host.

### Without Docker: configure
The service reads environment variables only (see `env.example`). It does not load
a `.env` file by itself.

| Variable | Meaning | Default |
|---|---|---|
| `DATABASE_URL` | Path of the SQLite file (accounts, sessions, templates) | `printninja-server.db` in the working directory |
| `PORT` | Listen port (binds `0.0.0.0`) | `3001` |
| `RUST_LOG` | Log level, for example `info` or `debug` | `info` |

Put the database file on persistent storage, for example
`DATABASE_URL=/var/lib/printninja/printninja-server.db`. On a host with an
ephemeral disk (many container platforms) the file, and so every account and
published template, is lost on each redeploy.

### Without Docker: run
Run it under a service manager so it restarts on failure. Example `systemd` unit
(`/etc/systemd/system/printninja-server.service`):

```ini
[Unit]
Description=PrintNinja share service
After=network.target

[Service]
ExecStart=/opt/printninja/printninja-server
Environment=DATABASE_URL=/var/lib/printninja/printninja-server.db
Environment=PORT=3001
Environment=RUST_LOG=info
Restart=on-failure
User=printninja

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now printninja-server
```

Put a reverse proxy (nginx, your company proxy, or your platform's TLS) in front, forward to
`127.0.0.1:3001`, and block direct access to the port from outside. The proxy
should set `X-Forwarded-For`, because the login throttle (5 per minute) keys on
that header. If the service is reachable directly, clients can fake it.

### Verify
```bash
curl https://your-host/health          # prints: ok
curl https://your-host/v1/templates    # JSON list (empty at first)
```
Then in the app open **Settings, Share**, enter the service address (for example
`https://share.example.com`), register, publish a template, and check it appears
in the **Templates, Community** tab.

### Back up (without Docker)
The SQLite file holds all accounts and templates. Make a consistent copy while
the service is running with:

```bash
sqlite3 /var/lib/printninja/printninja-server.db ".backup '/backups/printninja-$(date +%F).db'"
```
Do not copy the file with plain `cp` while the service is writing. Test a restore
at least once.

### Update and roll back (without Docker)
1. Build the new binary and copy it to the host next to the old one.
2. Stop the service, swap the binary, start it, and run the checks above.
3. Rollback: put the previous binary back and restart.

`db::init_db` uses `CREATE TABLE IF NOT EXISTS`, which does not change tables that
already exist. A release that adds or changes columns needs a manual migration of
the live database (back it up first) before the new binary starts.

### Not automated
Nothing here runs in CI: the image is built on the host that runs it. Adding a
CI job that builds `server/` (and the Docker image) and runs its tests is a
possible next step.

## Clean up cache

```bash
cd src-tauri && cargo clean
pnpm store prune
```
