# syntax=docker/dockerfile:1
# PrintNinja v2 service (REFACTORING.md Phase 1, packaging).
# Multi-stage: build with the full toolchain, ship compiled JS plus the
# production dependencies only. Base image pinned by the Phase 1 spike.
FROM node:22-bookworm-slim AS build

# Prisma needs the `openssl` command to pick the right engine; the slim
# image only has the libraries.
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.34.7 --activate

WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY server/package.json server/
COPY e2e/package.json e2e/
RUN pnpm install --frozen-lockfile

COPY server/ server/
WORKDIR /app/server
# Migrations run at boot, so the schema travels with the sources.
# Generate needs no database, but loading prisma.config.ts requires the
# variable to exist — the dummy value is never connected to.
# inject-workspace-packages satisfies pnpm v10's deploy guard; the
# --legacy deploy mis-resolves the pinned zod (3.25 instead of 4.6.7).
RUN DATABASE_URL=postgresql://localhost:5432/printninja_build_dummy \
    pnpm db:generate && pnpm build \
    && npm_config_inject_workspace_packages=true pnpm --filter server --prod deploy /deploy

# Ship only what the service needs at runtime: the compiled bundle, the
# production dependencies, the migrations and the entrypoint. Sources,
# tests, docs, env files and build configs are removed HERE, so they never
# enter a runtime layer. The entrypoint is forced to LF and executable so a
# Windows checkout (CRLF, no mode bits) cannot break the container.
RUN cd /deploy \
    && rm -rf src test scripts openapi Dockerfile .dockerignore docker-compose.yml \
       .env .env.sample tsconfig.json tsconfig.build.json vitest.config.ts \
       vitest.e2e.config.mts .dependency-cruiser.mjs \
    && sed -i 's/\r$//' docker-entrypoint.sh \
    && chmod 755 docker-entrypoint.sh

FROM node:22-bookworm-slim AS runtime

# Same reason as in the build stage: Prisma's migrate step runs here.
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    PATH="/srv/node_modules/.bin:${PATH}"

WORKDIR /srv
# --chown on COPY avoids a second, full-size `chown -R` layer. The node
# image already ships an unprivileged `node` user (uid 1000); the service
# writes nothing to disk (logs go to stdout) and must not run as root.
COPY --from=build --chown=node:node /deploy ./
USER node

EXPOSE 3001

# No curl in the slim image; node itself probes readiness (liveness plus a
# database round-trip), so an unhealthy database fails the check.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3001') + '/v2/ready').then((r) => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]