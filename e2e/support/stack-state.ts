import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Stack state shared between the global setup, the teardown and the
// fixtures. Playwright runs each in its own process, so the handoff is a
// JSON file, not memory.

export interface StackState {
  apiUrl: string;
  agentBundle: string;
  pgContainerId?: string;
  servicePid?: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const stateFile = join(here, ".stack.json");

export function writeStackState(state: StackState): void {
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

export function readStackState(): StackState {
  const raw = readFileSync(stateFile, "utf8");
  return JSON.parse(raw) as StackState;
}
