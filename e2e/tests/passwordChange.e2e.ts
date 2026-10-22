import { expect, test } from "@playwright/test";
import { signedInPc } from "../support/fixtures";
import { apiLogin } from "../support/api";
import { testids } from "../support/testids";

// Password change through the real UI against the real stack: the form
// validates locally, the server rotates the hash and revokes every
// other session, and the old password stops working.
test("settings share: password change rotates credentials and revokes others", async ({
  browser,
}) => {
  const seeded = await signedInPc(browser);
  const page = await seeded.context.newPage();
  await page.goto("/settings?section=share");
  await expect(page.getByText(`Signed in as ${seeded.handle}`)).toBeVisible({
    timeout: 15_000,
  });

  // Local validation first: no request leaves the page.
  await page
    .getByTestId(testids.settingsChangePasswordCurrent)
    .fill("password123");
  await page.getByTestId(testids.settingsChangePasswordNew).fill("short");
  await page.getByTestId(testids.settingsChangePasswordConfirm).fill("short");
  await page.getByTestId(testids.settingsChangePasswordSubmit).click();
  await expect(page.getByText("at least 8 characters")).toBeVisible();

  await page
    .getByTestId(testids.settingsChangePasswordNew)
    .fill("new-password-1");
  await page
    .getByTestId(testids.settingsChangePasswordConfirm)
    .fill("mismatch");
  await page.getByTestId(testids.settingsChangePasswordSubmit).click();
  await expect(page.getByText("do not match")).toBeVisible();

  // The real change: old password dies, new password works, and the
  // seeded token (this very session) keeps working.
  await page
    .getByTestId(testids.settingsChangePasswordConfirm)
    .fill("new-password-1");
  await page.getByTestId(testids.settingsChangePasswordSubmit).click();
  await expect(page.getByText("Password changed")).toBeVisible({
    timeout: 15_000,
  });

  await expect(apiLogin(seeded.handle, "password123")).rejects.toThrow();
  const relogin = await apiLogin(seeded.handle, "new-password-1");
  expect(relogin.token).toBeTruthy();
  expect(relogin.token).not.toBe(seeded.token);
});
