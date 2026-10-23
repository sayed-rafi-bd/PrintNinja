import { expect, test } from "@playwright/test";
import {
  apiPutTemplate,
  apiRegister,
} from "../support/api";
import { pc } from "../support/fixtures";
import { testids } from "../support/testids";

// F8 (REFACTORING.md section 11): A saves two labelled versions through
// the server. B opens the Designer and sees both, restores the first (a
// new revision appears, nothing is lost) and deletes the older one. The
// current version cannot be deleted.

test("F8 version history on the server", async ({ browser }) => {
  test.setTimeout(300_000);
  const auth = await apiRegister(
    `f8-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    "password123",
  );
  // Server-first: the template starts on the server, A pulls it.
  await apiPutTemplate(auth.token, crypto.randomUUID(), {
    name: "Versioned",
    body: "<p>v1</p>",
  });
  const pcA = await pc(browser, {
    settings: { share_session_token: auth.token },
  });
  const pageA = await pcA.context.newPage();
  await pageA.goto("/templates");
  await expect(pageA.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  await expect(pageA.getByText("Versioned")).toBeVisible({ timeout: 30_000 });

  const idA: number = await pageA.evaluate(() =>
    (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__
      .invoke("list_templates", {})
      .then(
        (rows) =>
          (rows as Array<{ id: number; name: string }>).find(
            (r) => r.name === "Versioned",
          )?.id ?? -1,
      ),
  );
  await pageA.goto(`/template/${idA}`);
  await expect(pageA.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });

  async function openVersions(page: import("@playwright/test").Page) {
    // The rail starts collapsed ("Open Versions"); opening a section
    // expands it, after which the accordion trigger owns the section.
    // Either may still be settling after the dialog closes, so wait.
    // The trigger toggles, so only click it when the list is hidden.
    const rail = page.getByRole("button", { name: "Open Versions" });
    const acc = page.getByRole("button", { name: "Versions", exact: true });
    const list = page.getByTestId(testids.versionList);
    await expect(rail.or(acc)).toBeVisible({ timeout: 15_000 });
    if (await rail.isVisible()) {
      await rail.click({ timeout: 15_000 });
      return;
    }
    if (!(await list.isVisible())) {
      await acc.click({ timeout: 15_000 });
    }
  }

  async function saveLabelled(html: string, label: string) {
    const content = pageA.getByLabel("HTML editor").locator(".cm-content");
    await content.click();
    await expect(async () => {
      await pageA.keyboard.press("ControlOrMeta+a");
      await pageA.keyboard.press("Backspace");
      expect(await content.textContent()).toBe("");
    }).toPass({ timeout: 15_000 });
    await pageA.keyboard.type(html, { delay: 10 });
    await pageA.getByTestId(testids.designerSaveVersion).click();
    await pageA.getByTestId(testids.versionLabel).fill(label);
    await pageA
      .getByRole("dialog")
      .getByRole("button", { name: "Save", exact: true })
      .click();
    // A labelled save is one push: the server records the version.
    await expect(
      pageA.getByText("Version saved to the server"),
    ).toBeVisible({ timeout: 30_000 });
    await openVersions(pageA);
    await expect(pageA.getByText(label)).toBeVisible({ timeout: 15_000 });
  }

  await saveLabelled("<p>v1-a</p>", "First");
  await saveLabelled("<p>v2-a</p>", "Second");

  // B opens the Designer and sees both labelled versions from the server.
  const pcB = await pc(browser, {
    settings: { share_session_token: auth.token },
  });
  const pageB = await pcB.context.newPage();
  await pageB.goto("/templates");
  await expect(pageB.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  await expect(pageB.getByText("Versioned")).toBeVisible({ timeout: 30_000 });
  const idB: number = await pageB.evaluate(() =>
    (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__
      .invoke("list_templates", {})
      .then(
        (rows) =>
          (rows as Array<{ id: number; name: string }>).find(
            (r) => r.name === "Versioned",
          )?.id ?? -1,
      ),
  );
  await pageB.goto(`/template/${idB}`);
  await openVersions(pageB);
  await expect(pageB.getByTestId(testids.versionList)).toBeVisible({
    timeout: 15_000,
  });
  await expect(pageB.getByTestId(testids.versionList)).toContainText("First");
  await expect(pageB.getByTestId(testids.versionList)).toContainText("Second");

  // Restoring the first makes a new revision; nothing is lost.
  await pageB.getByRole("button", { name: "Restore version 1" }).click();
  await expect(pageB.getByTestId(testids.versionRow(4))).toBeVisible({
    timeout: 30_000,
  });
  await expect(pageB.getByTestId(testids.versionList)).toContainText("Second");

  // Deleting the older one removes it; the current one is protected.
  await pageB.getByRole("button", { name: "Delete version 2" }).click();
  await expect(pageB.getByTestId(testids.versionRow(2))).toBeHidden({
    timeout: 30_000,
  });
  await expect(
    pageB.getByRole("button", { name: "Delete version 4" }),
  ).toBeDisabled();
});
