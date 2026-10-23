import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { apiRegister, apiSyncChanges } from "../support/api";
import { pc } from "../support/fixtures";
import { readStackState } from "../support/stack-state";
import { testids } from "../support/testids";

const PASSWORD = "password123";

function blockApi(context: BrowserContext, apiUrl: string) {
  return context.route("**/*", (route) => {
    if (route.request().url().startsWith(apiUrl)) {
      return route.abort();
    }
    return route.continue();
  });
}

type Invoke = (cmd: string, args?: unknown) => Promise<unknown>;

function invoke(page: Page): Invoke {
  return (cmd, args) =>
    page.evaluate(
      ([c, a]) =>
        (
          window as unknown as {
            __TAURI_INTERNALS__: {
              invoke: (cmd: string, args?: unknown) => Promise<unknown>;
            };
          }
        ).__TAURI_INTERNALS__.invoke(c, a),
      [cmd, args] as const,
    ) as Promise<unknown>;
}

const tinyTtf = () =>
  Buffer.from([
    0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xaa, 0xbb, 0xcc, 0xdd,
  ]);

// The server owns the library, and sending local edits there is an
// explicit action per entity — so with the share down, dataset, profile,
// font and setting writes land in the local cache and stay there. When
// the share returns, a reload pulls; nothing the user did offline
// uploads on its own. (The template half of this guarantee is F12.)
test("offline library edits stay local and never upload on recovery", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const handle = `e2e-lib-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const auth = await apiRegister(handle, PASSWORD);
  const serverId = crypto.randomUUID();

  const seeded = await pc(browser, {
    settings: { share_session_token: auth.token },
    printers: [{ name: "E2E Offline Printer" }],
    templates: [
      {
        name: "Library Base",
        server_id: serverId,
        html: "<p>base</p>",
        sync_state: "synced",
      },
    ],
  });
  const page = await seeded.context.newPage();
  await page.goto("/templates");
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });

  // Block at the stack URL, not the page's localStorage copy: the fake
  // agent keeps settings in its own store, so the localStorage key the
  // app falls back to is empty and blocking it no-ops (offline.e2e
  // reads the stack state for the same reason).
  await blockApi(seeded.context, readStackState().apiUrl);
  await page.goto("/templates");
  // The share-status check retries once before declaring offline, so the
  // banner can take a few seconds to appear after the block starts.
  await expect(page.getByTestId(testids.offlineBanner)).toBeVisible({
    timeout: 15_000,
  });

  const run = invoke(page);
  const templates = (await run("list_templates", {})) as Array<{
    id: number;
    name: string;
  }>;
  const templateId = templates.find((t) => t.name === "Library Base")?.id;
  expect(templateId).toBeGreaterThan(0);
  const printers = (await run("list_printers", {})) as Array<{
    id: number;
    name: string;
  }>;
  const printerId = printers.find((p) => p.name === "E2E Offline Printer")?.id;
  expect(printerId).toBeGreaterThan(0);

  await run("save_dataset", {
    req: {
      name: "Offline Orders",
      data_json: '{"rows":[{"id":"offline-1","total":42}]}',
    },
  });
  await run("save_profile", {
    req: {
      printer_id: printerId,
      template_id: templateId,
      settings_json: '{"dark":true}',
    },
  });
  await run("upload_font", {
    file_name: "body.ttf",
    file_data: [...tinyTtf()],
  });
  await run("set_setting", { key: "brand_name", value: "Offline Brand" });

  // Everything the user wrote is in the local cache and usable there.
  await expect(async () => {
    const datasets = (await run("list_datasets", {})) as Array<{
      name: string;
    }>;
    expect(datasets.map((d) => d.name)).toContain("Offline Orders");
    const brand = await run("get_setting", { key: "brand_name" });
    expect(brand).toBe("Offline Brand");
  }).toPass({ timeout: 10_000 });

  // Recovery pulls; nothing offline uploads — the server stream stays
  // empty of these rows.
  await seeded.context.unroute("**/*");
  await page.reload();
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  await expect(async () => {
    const sync = await apiSyncChanges(
      auth.token,
      "dataset,profile,font,setting",
    );
    expect(sync.changes).toEqual([]);
  }).toPass({ timeout: 30_000 });

  // And the local copies survive the reload.
  await expect(async () => {
    const datasets = (await run("list_datasets", {})) as Array<{
      name: string;
      data_json: string;
    }>;
    const found = datasets.find((d) => d.name === "Offline Orders");
    expect(found?.data_json).toContain("offline-1");
  }).toPass({ timeout: 15_000 });
});
