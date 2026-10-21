import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readStackState } from "./stack-state.js";

// Stops what support/stack.ts started: the API process and the
// PostgreSQL container. The bundle and the stack file are build
// artifacts of the run, removed with it.

export default async function globalTeardown(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const stateFile = join(here, ".stack.json");
  let state;
  try {
    state = readStackState();
  } catch {
    return;
  }

  if (state.servicePid !== undefined) {
    try {
      process.kill(state.servicePid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  if (state.pgContainerId !== undefined) {
    try {
      execFileSync("docker", ["stop", state.pgContainerId], { stdio: "pipe" });
      execFileSync("docker", ["rm", state.pgContainerId], { stdio: "pipe" });
    } catch {
      // Already gone; Testcontainers' ryuk reaps the rest.
    }
  }

  rmSync(stateFile, { force: true });
  rmSync(join(here, "fake-agent.bundle.js"), { force: true });
}
