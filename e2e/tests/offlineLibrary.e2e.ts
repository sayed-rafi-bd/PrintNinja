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

// Offline queue + replay for the library entities, mirroring F12's
// template flow: with the share down, dataset/profile/font/setting
// writes wait dirty in the cache; when the share returns, a reload
// pushes them and the server stream shows every upsert.
test("offline library edits queue dirty and replay on recovery", async ({
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
  await expect(page.getByTestId(testids.offlineBanner)).toBeVisible();

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
    req: { name: "Offline Orders", data_json: '{"rows":[]}' },
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

  await expect(async () => {
    const dirty = await page.evaluate(() => {
      const pick = (key: string) =>
        JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{
          sync_state?: string;
        }>;
      return [
        ...pick("fake-agent:datasets").map((r) => r.sync_state),
        ...pick("fake-agent:profiles").map((r) => r.sync_state),
        ...pick("fake-agent:fonts").map((r) => r.sync_state),
      ];
    });
    expect(dirty).toContain("dirty");
    expect(dirty).not.toContain("synced");
  }).toPass({ timeout: 10_000 });

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
    const names = sync.changes.map(
      (c) =>
        `${c.entity}:${c.op}:${(c.data as { name?: string; key?: string } | undefined)?.name ?? (c.data as { key?: string } | undefined)?.key ?? (c.data as { printer_name?: string } | undefined)?.printer_name}`,
    );
    expect(names).toContain("dataset:upsert:Offline Orders");
    expect(names).toContain("font:upsert:body");
    expect(names).toContain("setting:upsert:brand_name");
    expect(names).toContain("profile:upsert:e2e offline printer");
  }).toPass({ timeout: 60_000 });
});
