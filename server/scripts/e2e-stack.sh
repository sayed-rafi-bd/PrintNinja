#!/bin/sh
# Resets the container e2e stack to a clean database, then boots it.
#
# Usage: sh server/scripts/e2e-stack.sh [--no-build] (run from anywhere;
# the stack lives in server/ next to this script).
#
# `docker compose down -v` drops the data volume, so the next boot
# migrates an empty database (see server/docker-entrypoint.sh) — every
# run starts from the same state no matter what a previous run left
# behind. The server then seeds the schema itself; the suites create
# their own accounts with run-unique handles.
#
# Extra arguments are passed to `docker compose up` (default: --build).
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/server"

if [ ! -f .env ]; then
  printf 'CORS_ORIGINS=http://localhost:1420\n' > .env
  echo "e2e-stack: wrote server/.env with dev defaults (not committed)"
fi

docker compose down -v

BUILD="--build"
for arg in "$@"; do
  if [ "$arg" = "--no-build" ]; then
    BUILD=""
  fi
done
# shellcheck disable=SC2086
RATE_LIMIT_MAX=10000 docker compose up -d $BUILD --wait --wait-timeout 180

for i in $(seq 1 30); do
  if curl -fsS http://localhost:3001/v2/health >/dev/null 2>&1; then
    echo "e2e-stack: service healthy at http://localhost:3001"
    echo "e2e-stack: run E2E_BASE_URL=http://localhost:3001 pnpm --filter server test:e2e"
    exit 0
  fi
  sleep 1
done
echo "e2e-stack: service did not become healthy; see 'docker compose logs'" >&2
exit 1
