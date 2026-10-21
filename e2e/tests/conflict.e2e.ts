import { expect, test } from "@playwright/test";
import { apiMine, apiRegister, apiVersion, apiVersions } from "../support/api";
import { pc } from "../support/fixtures";
import { readStackState } from "../support/stack-state";
import { testids } from "../support/testids";

// F6 (REFACTORING.md section 11): A and B both edit offline, A pushes,
// B pushes and gets 409 with the conflict dialog. One run per outcome:
// Keep mine (server revision moves past A's, A's edit stays in
// history), Take server, Keep both (a second template appears).

const PASSWORD = "password123";

function blockApi(
  context: import("@playwright/test").BrowserContext,
  apiUrl: string,
) {
  return context.route("**/*", (route) => {
    if (route.request().url().startsWith(apiUrl)) {
      return route.abort();
    }
    return route.continue();
  });
}

async function editHtml(
  page: import("@playwright/test").Page,
  templateId: number,
  html: string,
) {
  await page.evaluate(
    ({ id, body }: { id: number; body: string }) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args?: unknown) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__.invoke("create_version", {
        req: { template_id: id, html: body, css: "", created_by: "manual" },
      }),
    { id: templateId, body: html },
  );
}

async function localId(
  page: import("@playwright/test").Page,
  name: string,
): Promise<number> {
  return page.evaluate(
    (n: string) =>
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
              (r) => r.name === n,
            )?.id ?? -1,
        ),
    name,
  );
}

async function remoteId(
  page: import("@playwright/test").Page,
  name: string,
): Promise<string> {
  return page.evaluate(
    (n: string) =>
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
            (rows as Array<{ name: string; remote_id: string }>).find(
              (r) => r.name === n,
            )?.remote_id ?? "",
        ),
    name,
  );
}

/** Two PCs on one account with the same synced template; both go
 * offline, both edit, A pushes (server at v2). B is still offline. */
async function setupConflict(
  browser: import("@playwright/test").Browser,
  stem: string,
) {
  test.setTimeout(150_000);
  const { apiUrl } = readStackState();
  const auth = await apiRegister(
    `${stem}-${Date.now().toString(36)}`,
    PASSWORD,
  );
  const pcA = await pc(browser, {
    settings: { share_session_token: auth.token },
  });
  const pageA = await pcA.context.newPage();
  await pageA.goto("/templates");
  await expect(pageA.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  await pageA.evaluate(
    (n: string) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args?: unknown) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__.invoke("create_template", {
        req: {
          name: n,
          page_w_mm: 210,
          page_h_mm: 297,
          html: "<p>v1</p>",
          css: "",
        },
      }),
    "Contended",
  );
  await pageA.reload();
  await expect(async () => {
    const mine = await apiMine(auth.token);
    expect(mine.items.map((t) => t.name)).toContain("Contended");
  }).toPass({ timeout: 30_000 });

  const pcB = await pc(browser, {
    settings: { share_session_token: auth.token },
  });
  const pageB = await pcB.context.newPage();
  await pageB.goto("/templates");
  await expect(pageB.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  await expect(pageB.getByText("Contended")).toBeVisible({ timeout: 30_000 });

  await blockApi(pcA.context, apiUrl);
  await blockApi(pcB.context, apiUrl);
  await editHtml(pageA, await localId(pageA, "Contended"), "<p>a-edit</p>");
  await editHtml(pageB, await localId(pageB, "Contended"), "<p>b-edit</p>");

  await pcA.context.unroute("**/*");
  await pageA.reload();
  const serverId = await remoteId(pageA, "Contended");
  await expect(async () => {
    const versions = await apiVersions(auth.token, serverId);
    expect(
      Math.max(...versions.items.map((v) => v.version_no)),
    ).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 30_000 });

  // B comes back: its pull skips the dirty row, its push 409s.
  await pcB.context.unroute("**/*");
  await pageB.reload();
  await expect(pageB.getByTestId("conflict-banner")).toBeVisible({
    timeout: 30_000,
  });
  return { auth, pageA, pageB, serverId };
}

test("F6 conflict: keep mine", async ({ browser }) => {
  const { auth, pageB, serverId } = await setupConflict(browser, "f6mine");
  await pageB.getByRole("button", { name: "Review" }).click();
  await pageB.getByTestId("conflict-keep-mine").click();
  // The banner leaves and the push retries against the new revision.
  await expect(pageB.getByTestId("conflict-banner")).toBeHidden({
    timeout: 30_000,
  });
  await expect(async () => {
    const versions = await apiVersions(auth.token, serverId);
    const head = Math.max(...versions.items.map((v) => v.version_no));
    expect(head).toBeGreaterThanOrEqual(3);
    const v = await apiVersion(auth.token, serverId, head);
    expect(v.body).toBe("<p>b-edit</p>");
    const older = await apiVersion(auth.token, serverId, head - 1);
    expect(older.body).toBe("<p>a-edit</p>");
  }).toPass({ timeout: 60_000 });
});

test("F6 conflict: take server", async ({ browser }) => {
  const { pageB } = await setupConflict(browser, "f6theirs");
  await pageB.getByRole("button", { name: "Review" }).click();
  await pageB.getByTestId("conflict-take-server").click();
  await expect(pageB.getByTestId("conflict-banner")).toBeHidden({
    timeout: 30_000,
  });
  await expect(async () => {
    const rows = await pageB.evaluate(() =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args?: unknown) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__.invoke("list_versions", { template_id: 1 }),
    );
    expect((rows as Array<{ html: string }>).map((r) => r.html)).toContain(
      "<p>a-edit</p>",
    );
  }).toPass({ timeout: 30_000 });
});

test("F6 conflict: keep both", async ({ browser }) => {
  const { pageB } = await setupConflict(browser, "f6both");
  await pageB.getByRole("button", { name: "Review" }).click();
  await pageB.getByTestId("conflict-keep-both").click();
  // The local content becomes a second template; the original takes
  // the server copy.
  await expect(pageB.getByTestId("conflict-banner")).toBeHidden({
    timeout: 30_000,
  });
  await expect(pageB.getByText("Contended (copy)")).toBeVisible({
    timeout: 30_000,
  });
});
