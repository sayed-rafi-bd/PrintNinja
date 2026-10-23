import { expect, test } from "@playwright/test";
import { apiMine, apiRegister, apiSyncChanges } from "../support/api";
import { pc } from "../support/fixtures";
import { readStackState } from "../support/stack-state";
import { testids } from "../support/testids";

// F12 (REFACTORING.md section 11): with a cache and a session the app
// opens while the API is down, edits show as pending, and recovery
// pushes them. Without a cache the unreachable screen stays and Retry
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

test("F12 offline start, pending edits, and recovery", async ({ browser }) => {
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

  // A local edit marks the row dirty; the push cannot reach the server,
  // so the row waits in the cache (the pending the chip reports once
  // the share is back). The edit touches every synced field — html, css,
  // readme and page size — so recovery proves the full content
  // round-trips, not just the row's existence.
  await page.evaluate(() =>
    (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__.invoke("create_version", {
      req: {
        template_id: 1,
        html: "<p>edited offline</p>",
        css: ".edited{color:red}",
        created_by: "manual",
      },
    }),
  );
  await page.evaluate(() =>
    (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__.invoke("update_readme", {
      req: { id: 1, readme: "# Offline Invoice\nEdited offline readme" },
    }),
  );
  await page.evaluate(() =>
    (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__.invoke("update_template_meta", {
      req: {
        id: 1,
        name: "Offline Invoice",
        page_w_mm: 100,
        page_h_mm: 150,
      },
    }),
  );
  await expect(async () => {
    const rows = await page.evaluate(
      () =>
        JSON.parse(
          localStorage.getItem("fake-agent:templates") ?? "[]",
        ) as Array<{ sync_state: string }>,
    );
    expect(rows.map((r) => r.sync_state)).toContain("dirty");
  }).toPass({ timeout: 10_000 });

  // The API comes back; a reload pulls and pushes the queued edit.
  await seeded.context.unroute("**/*");
  await page.reload();
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  await expect(async () => {
    const mine = await apiMine(auth.token);
    expect(mine.items.map((t) => t.name)).toContain("Offline Invoice");
  }).toPass({ timeout: 30_000 });
  // The pushed upsert carries the edited content, not just the row:
  // html, css, readme and page size all land server-side.
  await expect(async () => {
    const sync = await apiSyncChanges(auth.token, "template");
    const upsert = sync.changes.find(
      (c) =>
        c.entity === "template" &&
        c.op === "upsert" &&
        (c.data as { id?: string } | undefined)?.id === serverId,
    );
    const data = upsert?.data as
      | {
          body?: string;
          css?: string;
          readme?: string;
          page_w_mm?: number;
          page_h_mm?: number;
        }
      | undefined;
    expect(data?.body).toContain("edited offline");
    expect(data?.css).toContain(".edited");
    expect(data?.readme).toContain("Edited offline readme");
    expect(data?.page_w_mm).toBe(100);
    expect(data?.page_h_mm).toBe(150);
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
