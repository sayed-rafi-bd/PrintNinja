import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readStackState, type StackState } from "./stack-state.js";

// Stops what support/stack.ts started: the API process and the
// PostgreSQL container. The bundle and the stack file are build
// artifacts of the run, removed with it.

export default async function globalTeardown(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const pids = new Set<number>();
  for (const entry of readdirSync(here)) {
    if (!/^\.stack(-\d+)?\.json$/.test(entry)) continue;
    try {
      const state = JSON.parse(
        readFileSync(join(here, entry), "utf8"),
      ) as StackState;
      for (const pid of [
        state.servicePid,
        ...(state.servicePids ?? []),
        state.virtualPrinter?.pid,
      ]) {
        if (pid !== undefined) pids.add(pid);
      }
    } catch {
      // Unreadable state: nothing to reap from it.
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  let pgContainerId: string | undefined;
  try {
    pgContainerId = readStackState().pgContainerId;
  } catch {
    pgContainerId = undefined;
  }
  if (pgContainerId !== undefined) {
    try {
      execFileSync("docker", ["stop", pgContainerId], { stdio: "pipe" });
      execFileSync("docker", ["rm", pgContainerId], { stdio: "pipe" });
    } catch {
      // Already gone; Testcontainers' ryuk reaps the rest. A missing
      // docker binary (Podman/rootless hosts) lands here too.
    }
  }

  for (const entry of readdirSync(here)) {
    if (/^\.stack(-\d+)?\.json$/.test(entry)) {
      rmSync(join(here, entry), { force: true });
    }
  }
  rmSync(join(here, "fake-agent.bundle.js"), { force: true });
}
