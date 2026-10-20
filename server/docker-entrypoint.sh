#!/bin/sh
# Bootstraps the database, then execs the service. The image carries the
# committed migrations and the Prisma CLI precisely so a first-ever
# `docker compose up` lands on a healthy service with no manual step.
set -eu

prisma migrate deploy
exec "$@"
