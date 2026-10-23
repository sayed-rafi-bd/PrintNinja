import { expect, test } from "@playwright/test";
import { apiMine, apiPutTemplate, apiRegister } from "../support/api";
import { pc } from "../support/fixtures";
import { testids } from "../support/testids";

// F3/F4/F5: the server owns the copies. A creates through the Designer
// (server first, then cached), edits with Save, deletes from the list —
// each an explicit, synchronous server round-trip. B pulls (startup and
// window focus) and sees each change with no manual refresh. Mutations
// go through the UI; sync is what is pinned here.

async function invoke<T>(
  page: import("@playwright/test").Page,
  cmd: string,
  args?: unknown,
): Promise<T> {
  return page.evaluate(
    ({ c, a }: { c: string; a: unknown }) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args?: unknown) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__.invoke(c, a),
    { c: cmd, a: args },
  );
}

async function localTemplateId(
  page: import("@playwright/test").Page,
  name: string,
): Promise<number> {
  const rows = await invoke<Array<{ id: number; name: string }>>(
    page,
    "list_templates",
    {},
  );
  return rows.find((r) => r.name === name)?.id ?? -1;
}

/** Type into the Designer's HTML editor, replacing its content. Returns
 * what the editor actually holds (tags auto-close as they are typed). */
async function setHtml(
  page: import("@playwright/test").Page,
  html: string,
): Promise<string> {
  const content = page.getByLabel("HTML editor").locator(".cm-content");
  await content.click();
  await expect(async () => {
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    expect(await content.textContent()).toBe("");
  }).toPass({ timeout: 15_000 });
  await page.keyboard.type(html, { delay: 5 });
  const actual = (await content.textContent()) ?? "";
  expect(actual).toContain(html.replace(/<[^>]*>/g, ""));
  return actual;
}

async function openDesignerOn(
  page: import("@playwright/test").Page,
  name: string,
) {
  await page.goto("/templates");
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(name, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.goto(`/template/${await localTemplateId(page, name)}`);
  await expect(page.getByTitle("Canvas preview")).toBeVisible({
    timeout: 15_000,
  });
}

test("F3 create on PC A appears on PC B", async ({ browser }) => {
  test.setTimeout(120_000);
  const handle = `f3-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const password = "password123";
  const auth = await apiRegister(handle, password);
  // A starts with one synced template so the Designer has somewhere to open.
  const starterId = crypto.randomUUID();
  await apiPutTemplate(auth.token, starterId, {
    name: "Starter",
    body: "<p>starter</p>",
  });

  const pcA = await pc(browser, {
    settings: { share_session_token: auth.token },
  });
  const pageA = await pcA.context.newPage();
  await openDesignerOn(pageA, "Starter");

  // New template: the dialog creates server-first, then caches locally.
  await pageA.getByRole("button", { name: "New template" }).click();
  await pageA.getByPlaceholder("My Template").fill("Shared Idea");
  await pageA.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    pageA.getByText('Template "Shared Idea" created on the server'),
  ).toBeVisible({ timeout: 30_000 });

  // The server holds it private; a reload keeps it from the cache.
  await expect(async () => {
    const mine = await apiMine(auth.token);
    expect(mine.items.map((t) => t.name)).toContain("Shared Idea");
  }).toPass({ timeout: 30_000 });

  // PC B signs in with the same account and pulls it with no extra step.
  const pcB = await pc(browser, {
    settings: { share_session_token: auth.token },
  });
  const pageB = await pcB.context.newPage();
  await pageB.goto("/templates");
  await expect(pageB.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  await expect(pageB.getByText("Shared Idea")).toBeVisible({ timeout: 30_000 });
});

test("F4 edit on PC A reaches PC B with no manual refresh", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const handle = `f4-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const password = "password123";
  const auth = await apiRegister(handle, password);
  const serverId = crypto.randomUUID();
  await apiPutTemplate(auth.token, serverId, {
    name: "Shared Idea",
    body: "<p>v1</p>",
  });

  const pcA = await pc(browser, {
    settings: { share_session_token: auth.token },
  });
  const pageA = await pcA.context.newPage();
  await openDesignerOn(pageA, "Shared Idea");

  const pcB = await pc(browser, {
    settings: { share_session_token: auth.token },
  });
  const pageB = await pcB.context.newPage();
  await pageB.goto("/templates");
  await expect(pageB.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  await expect(pageB.getByText("Shared Idea")).toBeVisible({ timeout: 30_000 });

  // A edits and saves: one synchronous push, server at v2.
  const edited = await setHtml(pageA, "<p>EDITED-V2</p>");
  await pageA.getByTestId(testids.designerSave).click();
  await expect(pageA.getByText("Saved to the server")).toBeVisible({
    timeout: 30_000,
  });

  // B receives a focus event and the Print page uses the new content
  // without any Refresh click. Wait for the pull to land first: the
  // navigation below would otherwise mount Print on the stale cache.
  await pageB.evaluate(() => window.dispatchEvent(new Event("focus")));
  const idB = await localTemplateId(pageB, "Shared Idea");
  await expect(async () => {
    const versions = await invoke<Array<{ html: string }>>(
      pageB,
      "list_versions",
      { template_id: idB },
    );
    expect(versions.map((v) => v.html)).toContain(edited);
  }).toPass({ timeout: 30_000 });
  await pageB.goto("/print");
  await pageB.getByRole("combobox", { name: "Template" }).click();
  await pageB.getByRole("option", { name: "Shared Idea" }).click();
  await expect(
    pageB.frameLocator('iframe[title="Print preview"]').getByText("EDITED-V2"),
  ).toBeVisible({ timeout: 30_000 });
});

test("F5 delete on PC A removes the template on PC B", async ({ browser }) => {
  test.setTimeout(120_000);
  const handle = `f5-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const password = "password123";
  const auth = await apiRegister(handle, password);
  const serverId = crypto.randomUUID();
  await apiPutTemplate(auth.token, serverId, {
    name: "Shared Idea",
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
  await expect(pageA.getByText("Shared Idea")).toBeVisible({ timeout: 30_000 });

  const pcB = await pc(browser, {
    settings: { share_session_token: auth.token },
  });
  const pageB = await pcB.context.newPage();
  await pageB.goto("/templates");
  await expect(pageB.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  await expect(pageB.getByText("Shared Idea")).toBeVisible({ timeout: 30_000 });

  // A deletes from the list: server copy and cache go together, after
  // a confirm. Nothing is queued — the server round-trip happens now.
  await pageA
    .getByRole("button", { name: "Delete Shared Idea everywhere" })
    .click();
  const dialog = await pageA.getByRole("dialog");
  await expect(
    dialog.getByText("Delete “Shared Idea” everywhere?"),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Delete template" }).click();
  await expect(pageA.getByText("Deleted “Shared Idea” everywhere")).toBeVisible(
    { timeout: 30_000 },
  );
  await expect(async () => {
    const mine = await apiMine(auth.token);
    expect(mine.items.map((t) => t.name)).not.toContain("Shared Idea");
  }).toPass({ timeout: 30_000 });

  // B's next pull removes it from the list with no manual step.
  await pageB.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(pageB.getByText("Shared Idea")).toBeHidden({ timeout: 30_000 });
});
