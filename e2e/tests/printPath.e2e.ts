import { expect, test } from "@playwright/test";
import { createConnection } from "node:net";
import { readStackState } from "../support/stack-state";

// Print-path proof at the harness level (no browser needed): the stack
// starts the vendored virtual printer, this spec pushes raw bytes at
// its JetDirect port and the dashboard reports the stored job. The
// Rust suite (src-tauri/tests/virtual_printer.rs) covers the device
// fault states and the IPP half; the UI half lives in
// printSubmit.e2e.ts; this is the wire between them.

async function dashboardJobs(dashboardUrl: string) {
  const response = await fetch(`${dashboardUrl}/api/status`);
  expect(response.ok).toBe(true);
  const body = (await response.json()) as {
    jobs_count: number;
    jobs: { id: number; proto: string; size: number; file: string }[];
  };
  return body;
}

async function sendRaw(port: number, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.write(bytes, (error) => {
        socket.end();
        if (error) reject(error);
        else resolve();
      });
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error("raw send timed out")), 10_000);
  });
}

test("raw bytes sent to the virtual printer land on its dashboard", async () => {
  const { virtualPrinter } = readStackState();
  expect(virtualPrinter, "stack starts the virtual printer").toBeDefined();
  const { dashboardUrl, rawPort } = virtualPrinter!;

  const before = await dashboardJobs(dashboardUrl);
  const payload = Buffer.from("PRINTNINJA-E2E-PROBE job\n");
  await sendRaw(rawPort, payload);

  let after = before;
  const deadline = Date.now() + 10_000;
  for (;;) {
    after = await dashboardJobs(dashboardUrl);
    if (after.jobs_count > before.jobs_count) break;
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect(after.jobs_count).toBe(before.jobs_count + 1);
  expect(after.jobs[0]?.proto).toBe("raw");
  expect(after.jobs[0]?.size).toBe(payload.length);

  const stored = await (
    await fetch(`${dashboardUrl}/jobs/${after.jobs[0]?.file}`)
  ).arrayBuffer();
  expect(Buffer.from(stored).equals(payload)).toBe(true);
});
