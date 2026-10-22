#!/bin/sh
# Bootstraps the database, then execs the service. The image carries the
# committed migrations and a small apply script (dist/infra/db/migrate.js)
# precisely because `prisma migrate deploy` cannot reach a remote Turso
# database: the runner executes the same migration.sql files through the
# libSQL client, so `file:` and `libsql://` URLs migrate identically.
# Set RUN_MIGRATIONS=false on all but one replica (or when migrating from
# a separate job) to skip the step.
set -eu

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "entrypoint: applying database migrations"
  node dist/infra/db/migrate.js
fi
exec "$@"
