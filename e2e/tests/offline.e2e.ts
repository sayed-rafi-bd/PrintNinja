import { expect, test } from "@playwright/test";
import { apiMine, apiRegister, apiSyncChanges } from "../support/api";
import { pc } from "../support/fixtures";
import { readStackState } from "../support/stack-state";
import { testids } from "../support/testids";

// F12: with a cache and a session the app opens while the API is down.
// Offline is viewing and printing only: the cached template lists, the
// Designer opens it, but Save stays disabled because the server owns
// the copies and there is nowhere to send. When the API comes back,
// a reload pulls, and an explicit Save sends the edit — nothing queues
// in between. Without a cache the unreachable screen stays and Retry
// recovers once the API is back.

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

test("F12 offline opens the cache view-only, recovery pulls then saves", async ({
  browser,
}) => {
  const { apiUrl } = readStackState();
  const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const handle = `f12-${runId}`;
  const auth = await apiRegister(handle, PASSWORD);

  // A synced cached copy with a run-unique server id (a fixed id would
  // collide with rows from previous runs, which belong to other users;
  // and it must be a UUID — the server rejects anything else with 400).
  const serverId = crypto.randomUUID();
  const seeded = await pc(browser, {
    settings: { share_session_token: auth.token },
    templates: [
      {
        name: "Offline Invoice",
        server_id: serverId,
        html: "<p>offline</p>",
        sync_state: "synced",
      },
    ],
  });
  const page = await seeded.context.newPage();
  await blockApi(seeded.context, apiUrl);

  await page.goto("/templates");
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  // The share-status check retries once before declaring offline, so the
  // banner can take a few seconds to appear after the block starts.
  await expect(page.getByTestId(testids.offlineBanner)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Offline Invoice")).toBeVisible();
  // The share is down, so the shell shows the offline badge; the
  // connection badge and the sync button render once the share is back.
  await expect(page.getByTitle("Share service unreachable")).toBeVisible();

  // The cached copy opens in the Designer, but Save is disabled: offline
  // is viewing and printing only, and the button says why.
  await page.getByRole("button", { name: /Edit/ }).first().click();
  await expect(page.getByTitle("Canvas preview")).toBeVisible({
    timeout: 15_000,
  });
  const saveButton = page.getByTestId(testids.designerSave);
  await expect(saveButton).toBeDisabled({ timeout: 15_000 });
  await expect(saveButton).toHaveAttribute(
    "title",
    /Offline — connect to save/,
  );

  // The API comes back; a reload pulls. The edit the user types now is
  // sent only when they explicitly save it — nothing queued offline.
  await seeded.context.unroute("**/*");
  await page.reload();
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId(testids.designerSave)).toBeEnabled({
    timeout: 15_000,
  });

  const content = page.getByLabel("HTML editor").locator(".cm-content");
  await content.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("<p>edited online</p>", { delay: 5 });
  await page.getByTestId(testids.designerSave).click();
  await expect(page.getByText("Saved to the server")).toBeVisible({
    timeout: 30_000,
  });
  // The pushed upsert carries the edited content, not just the row.
  await expect(async () => {
    const sync = await apiSyncChanges(auth.token, "template");
    const upsert = sync.changes.find(
      (c) =>
        c.entity === "template" &&
        c.op === "upsert" &&
        (c.data as { id?: string } | undefined)?.id === serverId,
    );
    const data = upsert?.data as { body?: string } | undefined;
    expect(data?.body).toContain("edited online");
  }).toPass({ timeout: 60_000 });
  await expect(page.getByTestId(testids.offlineBanner)).toBeHidden();
  await expect(page.getByTestId(testids.syncChip)).toBeVisible();
});

test("F12 without a cache the unreachable screen stays and Retry works", async ({
  browser,
}) => {
  const { apiUrl } = readStackState();
  const auth = await apiRegister(
    `f12-nocache-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    PASSWORD,
  );
  const seeded = await pc(browser, {
    settings: { share_session_token: auth.token },
  });
  const page = await seeded.context.newPage();
  await blockApi(seeded.context, apiUrl);

  await page.goto("/templates");
  await expect(page.getByTestId(testids.gateUnreachable)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Offline Invoice")).toBeHidden();

  await seeded.context.unroute("**/*");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
});
