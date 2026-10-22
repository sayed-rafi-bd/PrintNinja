import { expect, test } from "@playwright/test";
import {
  apiPublish,
  apiPutTemplate,
  apiRegister,
  apiSaveTemplate,
  apiUnpublish,
} from "../support/api";
import { pc } from "../support/fixtures";
import { testids } from "../support/testids";

const PASSWORD = "password123";

// Community negative paths: withdrawal does not take away a saved
// offline copy (printing stays local-first), saving a withdrawn
// template is a 404, gibberish searches show the empty gallery, and
// saving twice stays idempotent.
test("withdrawn templates still print from the saved copy", async ({
  browser,
}) => {
  const auth = await apiRegister(
    `neg-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    PASSWORD,
  );
  const serverId = crypto.randomUUID();
  await apiPutTemplate(auth.token, serverId, {
    name: "Withdrawn Label",
    body: "<p>withdrawn</p>",
  });
  await apiPublish(auth.token, serverId);

  // A second user saves it: saving your own template has no Save button
  // in the Community gallery, so the saver and the publisher differ.
  const viewer = await apiRegister(
    `negv-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    PASSWORD,
  );
  const seeded = await pc(browser, {
    settings: { share_session_token: viewer.token },
    printers: [{ name: "E2E Negative Printer" }],
  });
  const page = await seeded.context.newPage();
  await page.goto("/templates");
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("tab", { name: /Community/ }).click();
  await expect(page.getByText("Withdrawn Label").first()).toBeVisible({
    timeout: 30_000,
  });
  const card = page.locator("li", { hasText: "Withdrawn Label" }).first();
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByRole("button", { name: "Saved" })).toBeVisible({
    timeout: 15_000,
  });

  // The author withdraws; the saved copy keeps working offline-first.
  await apiUnpublish(auth.token, serverId);

  await page.goto("/print");
  await page.getByRole("combobox", { name: "Printer" }).click();
  await page.getByRole("option", { name: "E2E Negative Printer" }).click();
  await page.getByRole("combobox", { name: "Template" }).click();
  await page.getByRole("option", { name: "Withdrawn Label" }).click();
  await expect(
    page.locator('iframe[title="Print preview"]').first(),
  ).toBeAttached({ timeout: 15_000 });
  await page.getByRole("button", { name: /^Print$/ }).click();
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          __FAKE_AGENT_CALLS: { cmd: string }[];
        }
      ).__FAKE_AGENT_CALLS.filter((c) => c.cmd === "print_html").length,
  );
  expect(calls).toBe(1);

  // And saving the withdrawn template directly is a 404.
  await expect(apiSaveTemplate(auth.token, serverId)).rejects.toThrow(/404/);
});

test("empty searches and duplicate saves behave", async ({ browser }) => {
  const auth = await apiRegister(
    `neg2-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    PASSWORD,
  );
  const serverId = crypto.randomUUID();
  await apiPutTemplate(auth.token, serverId, {
    name: "Negative Searchable",
    body: "<p>x</p>",
  });
  await apiPublish(auth.token, serverId);

  const seeded = await pc(browser, {
    settings: { share_session_token: auth.token },
  });
  const page = await seeded.context.newPage();
  await page.goto("/templates");
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("tab", { name: /Community/ }).click();

  await page.getByLabel("Search templates").fill("zzz-no-such-template");
  await expect(page.getByText("No published templates yet")).toBeVisible({
    timeout: 15_000,
  });

  // Saving twice is idempotent: both succeed with no error.
  await expect(apiSaveTemplate(auth.token, serverId)).resolves.toBeUndefined();
  await expect(apiSaveTemplate(auth.token, serverId)).resolves.toBeUndefined();
});
