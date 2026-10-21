import { expect, test } from "@playwright/test";
import { apiRegister, apiSyncChanges } from "../support/api";
import { pc } from "../support/fixtures";
import { testids } from "../support/testids";
import type { Browser, Page } from "@playwright/test";

// Phase 4 (REFACTORING.md F9-F11 plus the dataset round-trip): a profile,
// a dataset, a font and a preference created on one PC show up on
// another; a device setting does not; a font file with the wrong content
// is refused. Mutations go through IPC (the twoPc precedent); the sync
// is what is pinned here.

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

async function gotoApp(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
}

async function localTemplateId(page: Page, name: string): Promise<number> {
  const rows = (await invoke(page)("list_templates", {})) as Array<{
    id: number;
    name: string;
  }>;
  const found = rows.find((r) => r.name === name);
  if (!found) throw new Error(`no local template named ${name}`);
  return found.id;
}

async function localPrinterId(page: Page, name: string): Promise<number> {
  const rows = (await invoke(page)("list_printers", {})) as Array<{
    id: number;
    name: string;
  }>;
  const found = rows.find((r) => r.name === name);
  if (!found) throw new Error(`no local printer named ${name}`);
  return found.id;
}

/** A PC with a pushed template: A creates, reloads, the engine pushes. */
async function pcWithTemplate(browser: Browser, stem: string) {
  const handle = `${stem}-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const auth = await apiRegister(handle, "password123");
  const pcA = await pc(browser, {
    settings: { share_session_token: auth.token },
    printers: [{ name: "E2E Label Printer" }],
  });
  const pageA = await pcA.context.newPage();
  await gotoApp(pageA, "/templates");
  await invoke(pageA)("create_template", {
    req: {
      name: "Shared Idea",
      page_w_mm: 210,
      page_h_mm: 297,
      html: "<p>shared</p>",
      css: "",
    },
  });
  await pageA.reload();
  await expect(async () => {
    const changes = await apiSyncChanges(auth.token, "template");
    expect(changes.changes.map((c) => c.op)).toContain("upsert");
  }).toPass({ timeout: 30_000 });
  return { auth, pcA, pageA };
}

test("F9 profile follows the user, unknown printers stay dormant", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { auth, pageA } = await pcWithTemplate(browser, "f9");

  // A saves a profile for its label printer and pushes it with a reload.
  const templateId = await localTemplateId(pageA, "Shared Idea");
  const printerId = await localPrinterId(pageA, "E2E Label Printer");
  await invoke(pageA)("save_profile", {
    req: {
      printer_id: printerId,
      template_id: templateId,
      settings_json: '{"dark":true}',
    },
  });
  await pageA.reload();
  await expect(async () => {
    const changes = await apiSyncChanges(auth.token, "profile");
    expect(
      changes.changes.filter(
        (c) => c.entity === "profile" && c.op === "upsert",
      ),
    ).toHaveLength(1);
  }).toPass({ timeout: 30_000 });

  // B signs in with the same account and its own same-named printer.
  const pcB = await pc(browser, {
    settings: { share_session_token: auth.token },
    printers: [{ name: "E2E Label Printer" }],
  });
  const pageB = await pcB.context.newPage();
  await gotoApp(pageB, "/templates");
  await expect(pageB.getByText("Shared Idea")).toBeVisible({ timeout: 30_000 });
  const templateB = await localTemplateId(pageB, "Shared Idea");
  const printerB = await localPrinterId(pageB, "E2E Label Printer");
  await expect(async () => {
    const rows = (await invoke(pageB)("list_profiles", {
      printer_id: printerB,
      template_id: templateB,
    })) as Array<{ settings_json: string }>;
    expect(rows.map((r) => r.settings_json)).toEqual(['{"dark":true}']);
  }).toPass({ timeout: 30_000 });

  // A PC whose printers do not include that name sees nothing: dormant.
  const pcC = await pc(browser, {
    settings: { share_session_token: auth.token },
    printers: [{ name: "Office Inkjet" }],
  });
  const pageC = await pcC.context.newPage();
  await gotoApp(pageC, "/templates");
  await expect(pageC.getByText("Shared Idea")).toBeVisible({ timeout: 30_000 });
  const templateC = await localTemplateId(pageC, "Shared Idea");
  const printerC = await localPrinterId(pageC, "Office Inkjet");
  const rows = (await invoke(pageC)("list_profiles", {
    printer_id: printerC,
    template_id: templateC,
  })) as unknown[];
  expect(rows).toEqual([]);

  // A delete on A withdraws the profile from B after the next pull.
  const savedRows = (await invoke(pageA)("list_profiles", {})) as Array<{
    id: number;
  }>;
  await invoke(pageA)("delete_profile", { id: savedRows[0]?.id ?? -1 });
  await pageA.reload();
  await expect(async () => {
    const changes = await apiSyncChanges(auth.token, "profile");
    expect(
      changes.changes.filter(
        (c) => c.entity === "profile" && c.op === "delete",
      ),
    ).toHaveLength(1);
  }).toPass({ timeout: 30_000 });
  await pageB.reload();
  await expect(async () => {
    const after = (await invoke(pageB)("list_profiles", {
      printer_id: printerB,
      template_id: templateB,
    })) as unknown[];
    expect(after).toEqual([]);
  }).toPass({ timeout: 30_000 });
});

test("dataset created on PC A appears on PC B", async ({ browser }) => {
  test.setTimeout(120_000);
  const { auth, pageA } = await pcWithTemplate(browser, "fds");

  await invoke(pageA)("save_dataset", {
    req: { name: "Orders", data_json: '{"rows":[]}' },
  });
  await pageA.reload();
  await expect(async () => {
    const changes = await apiSyncChanges(auth.token, "dataset");
    expect(
      changes.changes.filter(
        (c) => c.entity === "dataset" && c.op === "upsert",
      ),
    ).toHaveLength(1);
  }).toPass({ timeout: 30_000 });

  const pcB = await pc(browser, {
    settings: { share_session_token: auth.token },
  });
  const pageB = await pcB.context.newPage();
  await gotoApp(pageB, "/templates");
  await expect(async () => {
    const rows = (await invoke(pageB)("list_datasets", {})) as Array<{
      name: string;
      data_json: string;
    }>;
    expect(rows).toEqual(
      [{ name: "Orders", data_json: '{"rows":[]}' }].map((r) =>
        expect.objectContaining(r),
      ),
    );
  }).toPass({ timeout: 30_000 });
});

// Minimal TTF: the 00 01 00 00 magic plus padding. The server checks
// magic bytes, never the extension.
const tinyTtf = () =>
  new Uint8Array([
    0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xaa, 0xbb, 0xcc, 0xdd,
  ]);

test("F10 font follows the user with states, wrong content is refused", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { auth, pageA } = await pcWithTemplate(browser, "f10");

  // A uploads in Settings; the engine pushes metadata and bytes on reload.
  await pageA.goto("/settings");
  await expect(pageA.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  await pageA.getByRole("tab", { name: "General" }).click();
  const [chooser] = await Promise.all([
    pageA.waitForEvent("filechooser", { timeout: 15_000 }),
    pageA.getByTestId(testids.settingsFontUpload).click(),
  ]);
  await chooser.setFiles({
    name: "body.ttf",
    mimeType: "font/ttf",
    buffer: Buffer.from(tinyTtf()),
  });
  const fontRow = pageA
    .locator('[data-testid^="font-row-"]')
    .filter({ hasText: "body" });
  await expect(fontRow).toBeVisible({ timeout: 15_000 });
  await pageA.reload();
  await expect(async () => {
    const changes = await apiSyncChanges(auth.token, "font");
    expect(
      changes.changes.filter((c) => c.entity === "font" && c.op === "upsert"),
    ).toHaveLength(1);
  }).toPass({ timeout: 30_000 });

  // B downloads after the pull: pending, then ready with the same bytes.
  const pcB = await pc(browser, {
    settings: { share_session_token: auth.token },
  });
  const pageB = await pcB.context.newPage();
  await pageB.goto("/settings");
  await expect(pageB.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  await pageB.getByRole("tab", { name: "General" }).click();
  await expect(async () => {
    const fonts = (await invoke(pageB)("list_fonts", {})) as Array<{
      family: string;
      state: string;
    }>;
    expect(fonts.map((f) => f.family)).toContain("body");
  }).toPass({ timeout: 30_000 });
  await expect(async () => {
    const fonts = (await invoke(pageB)("list_fonts", {})) as Array<{
      family: string;
      state: string;
    }>;
    expect(fonts.find((f) => f.family === "body")?.state).toBe("ready");
  }).toPass({ timeout: 60_000 });
  const files = (await invoke(pageB)("cache_read_font_file", {
    server_id: (
      (await invoke(pageB)("list_fonts", {})) as Array<{
        family: string;
        server_id: string;
      }>
    ).find((f) => f.family === "body")?.server_id,
  })) as number[];
  expect(files).toEqual([...tinyTtf()]);

  // Wrong content with a font extension is refused inline, not stored.
  await pageA.getByRole("tab", { name: "General" }).click();
  const [badChooser] = await Promise.all([
    pageA.waitForEvent("filechooser", { timeout: 15_000 }),
    pageA.getByTestId(testids.settingsFontUpload).click(),
  ]);
  await badChooser.setFiles({
    name: "evil.ttf",
    mimeType: "font/ttf",
    buffer: Buffer.from("%PDF-1.4 nope, not a font"),
  });
  await expect(pageA.getByRole("alert")).toContainText(/failed/i, {
    timeout: 15_000,
  });

  // A delete on A withdraws the font from B after the next pull.
  const fontId = (
    (await invoke(pageA)("list_fonts", {})) as Array<{
      id: number;
      family: string;
    }>
  ).find((f) => f.family === "body")?.id;
  await invoke(pageA)("delete_font", { id: fontId });
  await pageA.reload();
  await expect(async () => {
    const changes = await apiSyncChanges(auth.token, "font");
    expect(
      changes.changes.filter((c) => c.entity === "font" && c.op === "delete"),
    ).toHaveLength(1);
  }).toPass({ timeout: 30_000 });
  await pageB.reload();
  await expect(pageB.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  await pageB.getByRole("tab", { name: "General" }).click();
  await expect(async () => {
    const fonts = (await invoke(pageB)("list_fonts", {})) as Array<{
      family: string;
    }>;
    expect(fonts.map((f) => f.family)).not.toContain("body");
  }).toPass({ timeout: 30_000 });
});

test("F11 preferences follow the user, device settings do not", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { auth, pageA } = await pcWithTemplate(browser, "f11");

  // A sets density + brand in Settings; the API port stays device-local
  // (set directly — its screen saves it only when starting the server).
  await pageA.goto("/settings");
  await expect(pageA.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  await pageA
    .getByTestId(testids.settingsDensity)
    .getByRole("radio", { name: /compact/i })
    .click();
  await pageA.getByTestId(testids.settingsBrandName).fill("Acme Labels");
  await pageA.getByTestId(testids.settingsBrandName).press("Enter");
  await invoke(pageA)("set_setting", { key: "api_port", value: "4321" });
  await pageA.reload();
  await expect(async () => {
    const changes = await apiSyncChanges(auth.token, "setting");
    const keys = changes.changes
      .filter((c) => c.entity === "setting" && c.op === "upsert")
      .map((c) => c.data?.key);
    expect(keys).toEqual(expect.arrayContaining(["ui_density", "brand_name"]));
    expect(keys).not.toContain("api_port");
  }).toPass({ timeout: 30_000 });

  // B pulls both preferences; the device setting never arrives.
  const pcB = await pc(browser, {
    settings: { share_session_token: auth.token },
  });
  const pageB = await pcB.context.newPage();
  await gotoApp(pageB, "/templates");
  await expect(async () => {
    const density = await pageB.evaluate(() =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args?: unknown) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__.invoke("get_setting", { key: "ui_density" }),
    );
    expect(density).toBe("compact");
  }).toPass({ timeout: 30_000 });
  await expect(async () => {
    const brand = await pageB.evaluate(() =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args?: unknown) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__.invoke("get_setting", { key: "brand_name" }),
    );
    expect(brand).toBe("Acme Labels");
  }).toPass({ timeout: 30_000 });
  const apiPort = await pageB.evaluate(() =>
    (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__.invoke("get_setting", { key: "api_port" }),
  );
  expect(apiPort).toBeNull();
});
