import { expect, test } from "@playwright/test";
import {
  apiMine,
  apiPutTemplate,
  apiRegister,
  apiVersion,
  apiVersions,
} from "../support/api";
import { pc } from "../support/fixtures";
import { testids } from "../support/testids";

// F6: the server owns the copies, so a conflict surfaces at save time,
// not in the background. A and B share one synced template; A saves
// (server at v2). B edits the stale copy and clicks Save: the server
// refuses with 409 and the Designer asks which copy wins. One run per
// outcome: Overwrite (B's content lands, A's stays in history) and Take
// server (B's editor loads A's copy).

const PASSWORD = "password123";

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

async function localId(
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

/**
 * Type into the Designer's HTML editor, replacing its content. The editor
 * auto-closes tags as they are typed, so the returned string is what the
 * editor actually holds — that (not the keystrokes) is what Save sends.
 */
async function setHtml(
  page: import("@playwright/test").Page,
  html: string,
): Promise<string> {
  const content = page.getByLabel("HTML editor").locator(".cm-content");
  await content.click();
  // Select-all + delete can leave a fragment when the editor is still
  // settling; repeat until the document is empty, then type.
  await expect(async () => {
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    expect(await content.textContent()).toBe("");
  }).toPass({ timeout: 15_000 });
  await page.keyboard.type(html, { delay: 5 });
  const actual = (await content.textContent()) ?? "";
  // The editor auto-closes tags, so only the inner text must match.
  expect(actual).toContain(html.replace(/<[^>]*>/g, ""));
  return actual;
}

/** Two PCs on one account with the same synced template. A saves an edit
 * (server at v2); B opens the same template and types a stale edit. */
async function setupConflict(
  browser: import("@playwright/test").Browser,
  stem: string,
) {
  test.setTimeout(240_000);
  const auth = await apiRegister(
    `${stem}-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    PASSWORD,
  );
  const serverId = crypto.randomUUID();
  await apiPutTemplate(auth.token, serverId, {
    name: "Contended",
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
  await expect(pageA.getByText("Contended")).toBeVisible({ timeout: 30_000 });

  const pcB = await pc(browser, {
    settings: { share_session_token: auth.token },
  });
  const pageB = await pcB.context.newPage();
  await pageB.goto("/templates");
  await expect(pageB.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  await expect(pageB.getByText("Contended")).toBeVisible({ timeout: 30_000 });

  // A opens the designer (v1 locally). B opens it too — also v1, and
  // no pull runs while both sit on the page.
  const idA = await localId(pageA, "Contended");
  const idB = await localId(pageB, "Contended");
  await pageA.goto(`/template/${idA}`);
  await expect(pageA.getByTitle("Canvas preview")).toBeVisible({
    timeout: 15_000,
  });
  await pageB.goto(`/template/${idB}`);
  await expect(pageB.getByTitle("Canvas preview")).toBeVisible({
    timeout: 15_000,
  });

  // A saves an edit through the Designer: server at v2.
  const aHtml = await setHtml(pageA, "<p>a-edit</p>");
  await pageA.getByTestId(testids.designerSave).click();
  await expect(pageA.getByText("Saved to the server")).toBeVisible({
    timeout: 30_000,
  });
  await expect(async () => {
    const versions = await apiVersions(auth.token, serverId);
    expect(
      Math.max(...versions.items.map((v) => v.version_no)),
    ).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 30_000 });

  // B types a conflicting edit on its stale copy (still v1 locally).
  const bHtml = await setHtml(pageB, "<p>b-edit</p>");
  return { auth, pageA, pageB, serverId, aHtml, bHtml };
}

test("F6 conflict: overwrite with mine", async ({ browser }) => {
  const { auth, pageB, serverId, aHtml, bHtml } = await setupConflict(
    browser,
    "f6mine",
  );
  await pageB.getByTestId(testids.designerSave).click();
  // The server refused the stale guard: the dialog names both ways out.
  await expect(pageB.getByTestId(testids.saveConflictDialog)).toBeVisible({
    timeout: 30_000,
  });
  await pageB.getByTestId(testids.saveConflictOverwrite).click();
  await expect(pageB.getByText("Overwrote the server copy")).toBeVisible({
    timeout: 30_000,
  });
  await expect(async () => {
    const versions = await apiVersions(auth.token, serverId);
    const head = Math.max(...versions.items.map((v) => v.version_no));
    expect(head).toBeGreaterThanOrEqual(3);
    const v = await apiVersion(auth.token, serverId, head);
    expect(v.body).toBe(bHtml);
    const older = await apiVersion(auth.token, serverId, head - 1);
    expect(older.body).toBe(aHtml);
  }).toPass({ timeout: 60_000 });
});

test("F6 conflict: take server copy", async ({ browser }) => {
  const { pageB, aHtml } = await setupConflict(browser, "f6theirs");
  await pageB.getByTestId(testids.designerSave).click();
  await expect(pageB.getByTestId(testids.saveConflictDialog)).toBeVisible({
    timeout: 30_000,
  });
  await pageB.getByTestId(testids.saveConflictTakeServer).click();
  await expect(pageB.getByText("Loaded the server copy")).toBeVisible({
    timeout: 30_000,
  });
  // The editor now holds A's copy (re-indented on load); the dialog
  // is gone and B's edit with it. CodeMirror applies the new document
  // a beat after the dialog closes, so both reads poll.
  await expect(
    pageB.getByTestId(testids.saveConflictDialog),
  ).toBeHidden({ timeout: 15_000 });
  const editor = pageB.getByLabel("HTML editor").locator(".cm-content");
  await expect(async () => {
    const editorText = (await editor.textContent()) ?? "";
    expect(editorText.replace(/\s+/g, "")).toContain(
      aHtml.replace(/\s+/g, ""),
    );
    expect(editorText).not.toContain("b-edit");
  }).toPass({ timeout: 15_000 });
});

test("F6 a fresh save after the pull needs no dialog", async ({
  browser,
}) => {
  const { auth, pageB, serverId, bHtml } = await setupConflict(
    browser,
    "f6clean",
  );
  // B refreshes first, then saves the same edit: the guard is current.
  await pageB.getByTestId(testids.templateSyncNow).click();
  await pageB.getByTestId(testids.designerSave).click();
  await expect(pageB.getByText("Saved to the server")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    pageB.getByTestId(testids.saveConflictDialog),
  ).toBeHidden({ timeout: 15_000 });
  await expect(async () => {
    const mine = await apiMine(auth.token);
    expect(mine.items.map((t) => t.name)).toContain("Contended");
    const versions = await apiVersions(auth.token, serverId);
    const head = Math.max(...versions.items.map((v) => v.version_no));
    const v = await apiVersion(auth.token, serverId, head);
    expect(v.body).toBe(bHtml);
  }).toPass({ timeout: 30_000 });
});
