import { expect, test } from "@playwright/test";
import { signedSeed } from "../support/fixtures";

// The UI half of the print path (REFACTORING.md section 11): on the
// Print page, choosing a printer and a template and pressing Print
// sends one print_html call carrying the whole form — options the
// backend added later (page range, grayscale) included. The fake agent
// answers print_html with null, so this spec pins the request shape,
// not the outcome; the wire to a real device is printPath.e2e.ts and
// the Rust virtual-printer suite.

interface FakeCall {
  cmd: string;
  args: { req?: Record<string, unknown> };
}

async function printCalls(page: {
  evaluate: <T>(fn: () => T) => Promise<T>;
}): Promise<FakeCall[]> {
  return page.evaluate(() =>
    (
      window as unknown as {
        __FAKE_AGENT_CALLS: FakeCall[];
      }
    ).__FAKE_AGENT_CALLS.filter((c) => c.cmd === "print_html"),
  );
}

test("print submits the whole form, including page range and grayscale", async ({
  browser,
}) => {
  const seeded = await signedSeed(browser, "submit", {
    templates: [
      {
        name: "Submit Label",
        server_id: crypto.randomUUID(),
        html: "<p>submit</p>",
        sync_state: "synced",
      },
    ],
    printers: [{ name: "E2E Submit Printer" }],
  });
  const page = await seeded.context.newPage();
  await page.goto("/print");
  await page.getByRole("combobox", { name: "Printer" }).click();
  await page.getByRole("option", { name: "E2E Submit Printer" }).click();
  await page.getByRole("combobox", { name: "Template" }).click();
  await page.getByRole("option", { name: "Submit Label" }).click();
  await expect(
    page.locator('iframe[title="Print preview"]').first(),
  ).toBeAttached({ timeout: 15_000 });

  await page.getByRole("button", { name: /Advanced options/ }).click();
  await page.getByLabel("Page range").fill("1-3");
  await page.getByLabel("Grayscale").click();

  await page.getByRole("button", { name: /^Print$/ }).click();

  await expect
    .poll(async () => (await printCalls(page)).length, { timeout: 15_000 })
    .toBe(1);
  const [call] = await printCalls(page);
  expect(call?.args.req).toMatchObject({
    printer_name: "E2E Submit Printer",
    page_range: "1-3",
    grayscale: true,
  });
  expect(typeof call?.args.req?.template_id).toBe("number");
});
