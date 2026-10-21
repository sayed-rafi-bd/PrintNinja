import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { writeStackState } from "./stack-state.js";

// Global setup: start PostgreSQL, run the committed migrations against
// it, start the API, bundle the fake agent. Everything the specs need
// arrives through e2e/support/.stack.json (separate processes cannot
// share memory); specs never start infrastructure themselves.

const here = dirname(fileURLToPath(import.meta.url));
const e2eDir = resolve(here, "..");
const repoDir = resolve(e2eDir, "..");
const serverDir = join(repoDir, "server");

const API_PORT = Number(process.env.E2E_API_PORT ?? 3101);

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${url}/v2/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `service at ${url} did not become healthy in ${timeoutMs} ms`,
      );
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }
}

export default async function globalSetup(): Promise<void> {
  // The fake agent rides into the page as one bundled IIFE.
  const bundlePath = join(e2eDir, "support", "fake-agent.bundle.js");
  await build({
    entryPoints: [join(e2eDir, "support", "fakeAgent", "index.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    outfile: bundlePath,
    logLevel: "silent",
  });

  const container = await new PostgreSqlContainer("postgres:16").start();
  const databaseUrl = container.getConnectionUri();
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
    cwd: serverDir,
    timeout: 120_000,
  });

  const distServer = join(serverDir, "dist", "server.js");
  if (!existsSync(distServer)) {
    throw new Error(
      `e2e needs the built service at ${distServer} — run "pnpm --filter server build" first`,
    );
  }
  const apiUrl = `http://127.0.0.1:${API_PORT}`;
  const service = spawn("node", [distServer], {
    cwd: serverDir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(API_PORT),
      DATABASE_URL: databaseUrl,
      LOG_LEVEL: "warn",
      CORS_ORIGINS: "http://localhost:1420",
      TRUST_PROXY: "0",
      SESSION_TTL_DAYS: "30",
      SESSION_CLEANUP_MINUTES: "60",
      // The stack is shared by every spec, so the brute-force limit
      // is relaxed here; the real limiter is pinned by E8 and the
      // server rate-limit tests.
      RATE_LIMIT_MAX: "1000",
      RATE_LIMIT_AUTH_MAX: "1000",
      RATE_LIMIT_AUTH_WINDOW_SECONDS: "300",
      // Low-cost argon2: e2e registers hundreds of users and never
      // measures hashing.
      ARGON2_MEMORY_KIB: "8",
      ARGON2_TIME_COST: "1",
      ARGON2_PARALLELISM: "1",
      DOCS_ENABLED: "false",
    },
    stdio: "pipe",
  });
  service.unref();

  try {
    await waitForHealth(apiUrl, 30_000);
  } catch (error) {
    service.kill();
    await container.stop();
    throw error;
  }

  writeStackState({
    apiUrl,
    agentBundle: bundlePath,
    pgContainerId: container.getId(),
    servicePid: service.pid,
  });
}
