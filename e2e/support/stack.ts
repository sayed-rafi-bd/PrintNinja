import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { writeStackState, writeWorkerStackStates } from "./stack-state.js";

// Global setup: bring up one API stack per Playwright worker — each with
// its own local SQLite file (migrated with the same runner production
// boots with) and its own server, so parallel specs never see each
// other's handles, templates or sessions. Everything the specs need
// arrives through per-worker stack files (separate processes cannot
// share memory); specs never start infrastructure themselves. No Docker,
// no cloud: the file database exercises the same Prisma + libSQL code
// path as Turso, minus the network.
//
// Worker count matches the Playwright config (CI: 4, local: 2) unless
// E2E_WORKERS overrides it; keep the two in sync.

const here = dirname(fileURLToPath(import.meta.url));
const e2eDir = resolve(here, "..");
const repoDir = resolve(e2eDir, "..");
const serverDir = join(repoDir, "server");

const BASE_API_PORT = Number(process.env.E2E_API_PORT ?? 3101);
const WORKERS = Number(process.env.E2E_WORKERS ?? (process.env.CI ? 4 : 2));

async function waitForHealth(
  url: string,
  timeoutMs: number,
  path = "/v2/health",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${url}${path}`);
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

  const dbDir = mkdtempSync(join(tmpdir(), "printninja-e2e-"));
  const distServer = join(serverDir, "dist", "server.js");
  if (!existsSync(distServer)) {
    throw new Error(
      `e2e needs the built service at ${distServer} — run "pnpm --filter server build" first`,
    );
  }

  const services: { pid?: number }[] = [];
  try {
    for (let worker = 0; worker < WORKERS; worker += 1) {
      services.push(await startWorkerApi(dbDir, worker));
    }
  } catch (error) {
    for (const service of services) {
      if (service.pid !== undefined) {
        try {
          process.kill(service.pid, "SIGTERM");
        } catch {
          // Already gone.
        }
      }
    }
    throw error;
  }

  const virtualPrinter = await startVirtualPrinter();
  const base = {
    apiUrl: `http://127.0.0.1:${BASE_API_PORT}`,
    agentBundle: bundlePath,
    dbDir,
    servicePid: services[0]?.pid,
    servicePids: services
      .map((service) => service.pid)
      .filter((pid) => pid !== undefined),
    workerCount: WORKERS,
    baseApiPort: BASE_API_PORT,
    virtualPrinter,
  };
  writeStackState(base);
  writeWorkerStackStates(base, WORKERS, BASE_API_PORT);
}

/**
 * One worker's API: its own database file (migrated from the committed
 * migrations with the same runner production boots with) and its own
 * server on BASE_API_PORT + worker index. The first worker keeps the
 * historic port, so a single-worker run behaves exactly like the old
 * shared stack.
 */
async function startWorkerApi(
  dbDir: string,
  worker: number,
): Promise<{ pid?: number }> {
  const databaseUrl = `file:${join(dbDir, `worker-${worker}.db`)}`;
  execFileSync("pnpm", ["--filter", "server", "db:apply"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
    cwd: repoDir,
    timeout: 120_000,
  });

  const port = BASE_API_PORT + worker;
  const apiUrl = `http://127.0.0.1:${port}`;
  const service = spawn("node", [join(serverDir, "dist", "server.js")], {
    cwd: serverDir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      LOG_LEVEL: "warn",
      CORS_ORIGINS: "http://localhost:1420",
      TRUST_PROXY: "0",
      SESSION_TTL_DAYS: "30",
      SESSION_CLEANUP_MINUTES: "60",
      // Each worker has its own server, so the relaxed brute-force
      // limit applies per worker; the real limiter is pinned by E8
      // and the server rate-limit tests. Every knob honors the
      // environment so the nightly prod-like run can tighten them to
      // production values (see .github/workflows/e2e-nightly.yml).
      RATE_LIMIT_MAX: process.env.E2E_RATE_LIMIT_MAX ?? "1000",
      RATE_LIMIT_AUTH_MAX: process.env.E2E_RATE_LIMIT_AUTH_MAX ?? "1000",
      RATE_LIMIT_AUTH_WINDOW_SECONDS:
        process.env.E2E_RATE_LIMIT_AUTH_WINDOW_SECONDS ?? "300",
      // Low-cost argon2: e2e registers hundreds of users and never
      // measures hashing.
      ARGON2_MEMORY_KIB: process.env.E2E_ARGON2_MEMORY_KIB ?? "8",
      ARGON2_TIME_COST: process.env.E2E_ARGON2_TIME_COST ?? "1",
      ARGON2_PARALLELISM: process.env.E2E_ARGON2_PARALLELISM ?? "1",
      DOCS_ENABLED: process.env.E2E_DOCS_ENABLED ?? "false",
    },
    stdio: "pipe",
  });
  service.unref();

  try {
    await waitForHealth(apiUrl, 30_000);
  } catch (error) {
    service.kill();
    throw error;
  }
  return { pid: service.pid };
}

/**
 * The vendored virtual printer (support/virtual-printer, std-only
 * Rust): build once, then serve raw/IPP on its default high ports with
 * a scratch jobs dir. Returns the dashboard URL, the raw port and the
 * printer pid for the stack file; throws when the binary cannot start,
 * so a broken fixture fails setup instead of every spec.
 */
async function startVirtualPrinter(): Promise<{
  dashboardUrl: string;
  rawPort: number;
  ippUrl: string;
  pid?: number;
}> {
  const printerDir = join(e2eDir, "support", "virtual-printer");
  execFileSync(
    "cargo",
    ["build", "--manifest-path", join(printerDir, "Cargo.toml")],
    {
      stdio: "pipe",
      timeout: 300_000,
    },
  );
  const binary = join(
    printerDir,
    "target",
    "debug",
    process.platform === "win32" ? "virtualprinter.exe" : "virtualprinter",
  );
  if (!existsSync(binary)) {
    throw new Error(`virtual printer binary missing at ${binary}`);
  }
  const jobsDir = mkdtempSync(join(tmpdir(), "printninja-vp-"));
  const rawPort = 20100;
  const dashboardUrl = "http://127.0.0.1:11080";
  const printer = spawn(binary, ["--jobs", jobsDir, "--host", "127.0.0.1"], {
    stdio: "pipe",
  });
  printer.unref();
  const state = {
    dashboardUrl,
    rawPort,
    ippUrl: "http://127.0.0.1:11631/ipp/print",
    pid: printer.pid,
  };
  try {
    await waitForHealth(dashboardUrl, 15_000, "/api/status");
  } catch (error) {
    printer.kill();
    throw error;
  }
  return state;
}
