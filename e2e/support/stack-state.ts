import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Stack state shared between the global setup, the teardown and the
// fixtures. Playwright runs each in its own process, so the handoff is a
// JSON file, not memory.

export interface StackState {
  apiUrl: string;
  agentBundle: string;
  dbDir?: string;
  servicePid?: number;
  servicePids?: number[];
  workerCount?: number;
  baseApiPort?: number;
  virtualPrinter?: {
    dashboardUrl: string;
    rawPort: number;
    ippUrl: string;
    pid?: number;
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const stateFile = join(here, ".stack.json");

/** Per-worker file; worker 0 is also written to the historic path. */
export function workerStateFile(worker: number): string {
  return join(here, `.stack-${worker}.json`);
}

export function writeStackState(state: StackState): void {
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

export function writeWorkerStackStates(
  base: StackState,
  workerCount: number,
  baseApiPort: number,
): void {
  for (let worker = 0; worker < workerCount; worker += 1) {
    const port = baseApiPort + worker;
    const state: StackState = {
      ...base,
      apiUrl: `http://127.0.0.1:${port}`,
    };
    writeFileSync(
      workerStateFile(worker),
      `${JSON.stringify(state, null, 2)}\n`,
    );
  }
  writeStackState({ ...base, apiUrl: `http://127.0.0.1:${baseApiPort}` });
}

export function readStackState(): StackState {
  // Playwright sets TEST_WORKER_INDEX per worker process; fall back to
  // the historic shared file outside a worker (setup, teardown, api.ts
  // without a worker context).
  const index = process.env.TEST_WORKER_INDEX;
  if (index !== undefined) {
    try {
      const raw = readFileSync(workerStateFile(Number(index)), "utf8");
      return JSON.parse(raw) as StackState;
    } catch {
      // Fall through to the shared file.
    }
  }
  const raw = readFileSync(stateFile, "utf8");
  return JSON.parse(raw) as StackState;
}
