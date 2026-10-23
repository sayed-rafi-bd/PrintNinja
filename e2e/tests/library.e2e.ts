import { expect, test } from "@playwright/test";
import {
  apiDeleteProfile,
  apiPutDataset,
  apiPutFont,
  apiPutFontFile,
  apiPutProfile,
  apiPutSetting,
  apiPutTemplate,
  apiRegister,
} from "../support/api";
import { pc } from "../support/fixtures";
import { testids } from "../support/testids";
import type { Browser, Page } from "@playwright/test";

// Phase 4 (F9-F11 plus the dataset round-trip): the server owns the
// library, and the scheduler pulls it down. A profile, a dataset, a
// font and preferences seeded on the server show up on a fresh PC;
// a device setting does not; a font file with the wrong content is
// refused at upload time. Sending local library edits to the server
// is explicit per-entity work that lands after templates; these specs
// pin the pull direction, which is what makes a second PC whole.

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

/** An account with a template on the server, and a PC that pulled it. */
async function pcWithTemplate(browser: Browser, stem: string) {
  const handle = `${stem}-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const auth = await apiRegister(handle, "password123");
  const templateId = crypto.randomUUID();
  await apiPutTemplate(auth.token, templateId, {
    name: "Shared Idea",
    body: "<p>shared</p>",
  });
  const pcA = await pc(browser, {
    settings: { share_session_token: auth.token },
    printers: [{ name: "E2E Label Printer" }],
  });
  const pageA = await pcA.context.newPage();
  await gotoApp(pageA, "/templates");
  await expect(pageA.getByText("Shared Idea")).toBeVisible({ timeout: 30_000 });
  return { auth, pcA, pageA, templateId };
}

test("F9 profile follows the user, unknown printers stay dormant", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { auth, pageA, templateId } = await pcWithTemplate(browser, "f9");

  // The profile lives on the server, addressed by printer name.
  const templateRowId = await localTemplateId(pageA, "Shared Idea");
  const printerId = await localPrinterId(pageA, "E2E Label Printer");
  expect(templateRowId).toBeGreaterThan(0);
  expect(printerId).toBeGreaterThan(0);
  const profileId = crypto.randomUUID();
  await apiPutProfile(auth.token, profileId, {
    template_id: templateId,
    printer_name: "E2E Label Printer",
    settings_json: '{"dark":true}',
  });

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

  // A delete on the server withdraws the profile from B after the pull.
  await apiDeleteProfile(auth.token, profileId);
  await pageB.reload();
  await expect(async () => {
    const after = (await invoke(pageB)("list_profiles", {
      printer_id: printerB,
      template_id: templateB,
    })) as unknown[];
    expect(after).toEqual([]);
  }).toPass({ timeout: 30_000 });
});

test("dataset created on the server appears on PC B", async ({ browser }) => {
  test.setTimeout(120_000);
  const { auth } = await pcWithTemplate(browser, "fds");

  await apiPutDataset(auth.token, crypto.randomUUID(), {
    name: "Orders",
    dataJson: '{"rows":[]}',
  });

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

  // The font (metadata and bytes) lives on the server.
  const fontId = crypto.randomUUID();
  await apiPutFont(auth.token, fontId, { name: "body" });
  await apiPutFontFile(auth.token, fontId, Buffer.from(tinyTtf()));

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
  await pageA.goto("/settings");
  await expect(pageA.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
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
});

test("F11 preferences follow the user, device settings do not", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { auth, pageA } = await pcWithTemplate(browser, "f11");

  // A still saves density + brand locally through Settings.
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
  await expect(async () => {
    const density = await invoke(pageA)("get_setting", { key: "ui_density" });
    expect(density).toBe("compact");
  }).toPass({ timeout: 15_000 });

  // The server holds the account preferences; the device setting is
  // never set there.
  await apiPutSetting(auth.token, "ui_density", "compact");
  await apiPutSetting(auth.token, "brand_name", "Acme Labels");

  // B pulls both preferences; the device setting never arrives.
  const pcB = await pc(browser, {
    settings: { share_session_token: auth.token },
  });
  const pageB = await pcB.context.newPage();
  await gotoApp(pageB, "/templates");
  await expect(async () => {
    const density = await invoke(pageB)("get_setting", { key: "ui_density" });
    expect(density).toBe("compact");
  }).toPass({ timeout: 30_000 });
  await expect(async () => {
    const brand = await invoke(pageB)("get_setting", { key: "brand_name" });
    expect(brand).toBe("Acme Labels");
  }).toPass({ timeout: 30_000 });
  const apiPort = await invoke(pageB)("get_setting", { key: "api_port" });
  expect(apiPort).toBeNull();
});
