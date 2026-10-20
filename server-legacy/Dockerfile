# syntax=docker/dockerfile:1
# PrintNinja share service. Build context is this folder (server/).
#   docker build -t printninja-server server/

# ---- Build stage -------------------------------------------------------------
# Cargo.lock is lockfile version 4, which needs Cargo 1.78+. rusqlite is built
# with its bundled SQLite, so only a C compiler is needed (included in this image).
FROM rust:1-bookworm AS build
WORKDIR /app

# Build the dependencies first, so they are cached until Cargo.toml/Cargo.lock change.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
    && cargo build --release --locked \
    && rm -rf src

# Then build the real code. `touch` makes sure Cargo notices the new sources.
COPY src ./src
RUN touch src/main.rs && cargo build --release --locked

# ---- Runtime stage -----------------------------------------------------------
FROM debian:bookworm-slim

# curl is only used by the health check.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin printninja \
    && mkdir /data \
    && chown printninja:printninja /data

COPY --from=build /app/target/release/printninja-server /usr/local/bin/printninja-server

# The database lives in /data. Mount a volume there, or accounts and published
# templates are lost when the container is replaced.
ENV DATABASE_URL=/data/printninja-server.db \
    PORT=3001 \
    RUST_LOG=info

USER printninja
WORKDIR /data
VOLUME /data
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["printninja-server"]
