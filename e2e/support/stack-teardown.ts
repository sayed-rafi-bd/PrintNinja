import { readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readStackState, type StackState } from "./stack-state.js";

// Stops what support/stack.ts started: the API processes and the virtual
// printer. The database files, the bundle and the stack files are build
// artifacts of the run, removed with it.

export default async function globalTeardown(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const pids = new Set<number>();
  const dbDirs = new Set<string>();
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
      if (state.dbDir !== undefined) dbDirs.add(state.dbDir);
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
  try {
    const state = readStackState();
    if (state.dbDir !== undefined) dbDirs.add(state.dbDir);
  } catch {
    // No shared state: nothing to clean.
  }
  for (const dir of dbDirs) {
    rmSync(dir, { recursive: true, force: true });
  }

  for (const entry of readdirSync(here)) {
    if (/^\.stack(-\d+)?\.json$/.test(entry)) {
      rmSync(join(here, entry), { force: true });
    }
  }
  rmSync(join(here, "fake-agent.bundle.js"), { force: true });
}
