import { expect, test } from "@playwright/test";
import { apiMine, apiRegister } from "../support/api";
import { pc } from "../support/fixtures";
import { testids } from "../support/testids";

// F14: a migrated install holds local-only templates. The server owns
// the copies, so nothing uploads on its own: no backup dialog appears,
// the rows list as drafts ("Not on the server"), and the account stays
// empty until the user explicitly saves one.

const PASSWORD = "password123";

test("F14 migrated local templates stay local drafts until explicitly saved", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const auth = await apiRegister(
    `f14-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    PASSWORD,
  );

  const seeded = await pc(browser, {
    settings: { share_session_token: auth.token, install_migrated: "1" },
    templates: [
      { name: "Local one", html: "<p>mine 1</p>" },
      { name: "Local two", html: "<p>mine 2</p>" },
    ],
  });
  const page = await seeded.context.newPage();
  await page.goto("/templates");
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });

  // No backup dialog: there is nothing to confirm, because nothing
  // uploads without an explicit Save.
  await expect(page.getByText(/Back up \d+ template/)).toBeHidden({
    timeout: 15_000,
  });

  // Both rows list as drafts that live only on this computer.
  await expect(page.getByText("Local one")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Local two")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Not on the server").first()).toBeVisible({
    timeout: 15_000,
  });

  // The server holds nothing from this install.
  await expect(async () => {
    const mine = await apiMine(auth.token);
    expect(mine.items).toHaveLength(0);
  }).toPass({ timeout: 30_000 });

  // A reload changes nothing: still listed, still local, still silent.
  await page.reload();
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Local one")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Back up \d+ template/)).toBeHidden({
    timeout: 15_000,
  });
  await expect(async () => {
    const mine = await apiMine(auth.token);
    expect(mine.items).toHaveLength(0);
  }).toPass({ timeout: 30_000 });

  // The manual path still works: saving one row from the list uploads it.
  await page
    .getByRole("button", { name: "Save Local one to the server" })
    .click();
  await expect(async () => {
    const mine = await apiMine(auth.token);
    expect(mine.items.map((t) => t.name)).toContain("Local one");
    expect(mine.items.map((t) => t.name)).not.toContain("Local two");
  }).toPass({ timeout: 30_000 });
});
