#!/bin/sh
# Bootstraps the database, then execs the service. The image carries the
# committed migrations and the Prisma CLI precisely so a first-ever
# `docker compose up` lands on a healthy service with no manual step.
# Set RUN_MIGRATIONS=false on all but one replica (or when migrating from
# a separate job) to skip the step.
set -eu

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "entrypoint: applying database migrations"
  prisma migrate deploy
fi
exec "$@"
