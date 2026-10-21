import { expect, test } from "@playwright/test";
import { pc } from "../support/fixtures";

// Batch lifecycle against the fake agent, whose batch store mirrors
// the Rust validation and cancel/retry rules in commands/batch.rs.
// There is no worker in the harness: rows stay queued until
// cancelled, and retry re-queues — the worker drain is covered by
// src-tauri worker tests, the device half by the Rust
// virtual-printer suite.

async function selectPrinterAndTemplate(page: {
  getByRole: any;
  getByLabel: any;
  locator: any;
}): Promise<void> {
  await page.getByRole("combobox", { name: "Printer" }).click();
  await page.getByRole("option", { name: "E2E Batch Printer" }).click();
  await page.getByRole("combobox", { name: "Template" }).click();
  await page.getByRole("option", { name: "Batch Label" }).click();
  await expect(
    page.locator('iframe[title="Print preview"]').first(),
  ).toBeAttached({ timeout: 15_000 });
}

test("batch create, cancel and retry through the UI", async ({ browser }) => {
  const seeded = await pc(browser, {
    printers: [{ name: "E2E Batch Printer" }],
    templates: [
      {
        name: "Batch Label",
        server_id: crypto.randomUUID(),
        html: "<p>{{name}}</p>",
        sync_state: "synced",
      },
    ],
  });
  const page = await seeded.context.newPage();
  await page.goto("/print");
  await selectPrinterAndTemplate(page);

  await page.getByRole("button", { name: "New batch" }).click();
  await page
    .getByPlaceholder(/Tea.*qty/)
    .fill('[{"name":"Tea","qty":2},{"name":"Coffee","qty":1}]');
  await page.getByRole("button", { name: "Start Batch" }).click();
  await expect(page.getByText("Batch queued: 2 record(s)")).toBeVisible({
    timeout: 15_000,
  });

  const row = page.getByText("Batch #1", { exact: false });
  await expect(row).toBeVisible();
  await expect(page.getByText("queued", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Cancel" }).first().click();
  await expect(page.getByText("Batch #1 cancelled")).toBeVisible({
    timeout: 15_000,
  });

  // Retry is direct-invoke here: the button only renders when the row
  // carries failures, and the fake has no worker to fail rows.
  await page.evaluate(() =>
    (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (c: string, a: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__.invoke("retry_batch", { id: 1 }),
  );
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText("queued", { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
});

test("batch validation rejects empty, broken and non-array input", async ({
  browser,
}) => {
  const seeded = await pc(browser, {
    printers: [{ name: "E2E Batch Printer" }],
    templates: [
      {
        name: "Batch Label",
        server_id: crypto.randomUUID(),
        html: "<p>{{name}}</p>",
        sync_state: "synced",
      },
    ],
  });
  const page = await seeded.context.newPage();
  await page.goto("/print");
  await selectPrinterAndTemplate(page);

  await page.getByRole("button", { name: "New batch" }).click();
  await page.getByRole("button", { name: "Start Batch" }).click();
  await expect(page.getByText("Please enter batch data")).toBeVisible();

  await page.getByPlaceholder(/Tea.*qty/).fill("{nope");
  await page.getByRole("button", { name: "Start Batch" }).click();
  await expect(page.getByText("Invalid JSON")).toBeVisible();

  await page.getByPlaceholder(/Tea.*qty/).fill('{"name":"Tea"}');
  await page.getByRole("button", { name: "Start Batch" }).click();
  await expect(page.getByText("must be a JSON array")).toBeVisible();
});
