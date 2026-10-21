import { expect, test } from "@playwright/test";
import { pc } from "../support/fixtures";
import { testids } from "../support/testids";

// Settings administration through the real UI: onboarding, branding,
// density, the API port field, trusted sources and logo validation.
// Account sync of these values is covered by library.e2e (F9-F11);
// this spec pins the admin interactions themselves.

test("onboarding welcomes a fresh install and routes onward", async ({
  browser,
}) => {
  const fresh = await pc(browser, {
    settings: { onboarding_done: null },
  });
  const page = await fresh.context.newPage();
  await page.goto("/");
  await expect(page.getByText("Welcome to PrintNinja")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Printing takes three steps:")).toBeVisible();
  await page.getByRole("button", { name: "Start printing" }).click();
  await expect(page).toHaveURL(/\/print$/);
});

test("settings admin: brand, density, API port, trusted sources, logo", async ({
  browser,
}) => {
  const seeded = await pc(browser, {});
  const page = await seeded.context.newPage();
  await page.goto("/settings?section=general");
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });

  // Brand name persists across reloads.
  await page.getByTestId(testids.settingsBrandName).fill("E2E Print Shop");
  await page.getByTestId(testids.settingsBrandName).press("Enter");
  await expect(page.getByText("Name saved")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId(testids.settingsBrandName)).toHaveValue(
    "E2E Print Shop",
  );

  // Density switches.
  const density = page.getByTestId(testids.settingsDensity);
  await density.getByRole("radio", { name: /Compact/ }).click();
  await expect(density.getByRole("radio", { name: /Compact/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // Invalid logos are refused with a reason, not stored.
  await page.goto("/settings?section=general");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByTestId(testids.settingsLogoUpload).click(),
  ]);
  await chooser.setFiles({
    name: "logo.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });
  await expect(page.getByRole("alert")).toHaveText(
    "Use a PNG, JPEG, WebP, or SVG image.",
  );

  // API port through the UI, not raw invoke.
  await page.goto("/settings?section=api");
  await page.getByTestId(testids.settingsApiPort).fill("17799");
  await expect(page.getByTestId(testids.settingsApiPort)).toHaveValue("17799");

  // Trusted sources add and remove.
  await page.getByLabel("Trusted source").fill("pos.local");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText("pos.local")).toBeVisible();
  await page.getByRole("button", { name: "Remove pos.local" }).click();
  await expect(page.getByText("pos.local")).toBeHidden();
});
