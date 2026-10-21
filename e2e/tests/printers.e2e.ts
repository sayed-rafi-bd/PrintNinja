import { expect, test, type Page } from "@playwright/test";
import { pc } from "../support/fixtures";

// Printer management against the fake agent, whose addPrinter mirrors
// the Rust validation in commands/printer.rs (empty name, unknown
// type/language, case-insensitive duplicates). UI paths go through the
// real PrinterSetup page; validation paths unreachable from the
// selects go through direct invoke calls with the same envelope.

async function openAdd(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Add printer" }).first().click();
  await expect(page.getByRole("heading", { name: "Add printer" })).toBeVisible({
    timeout: 15_000,
  });
}

test("printers add, reject duplicates, test and remove", async ({
  browser,
}) => {
  const seeded = await pc(browser, {});
  const page = await seeded.context.newPage();
  await page.goto("/printers");

  await openAdd(page);
  await page.getByLabel("Printer name").fill("E2E JetDirect");
  await page.getByLabel("Connection").click();
  await page.getByRole("option", { name: /Raw TCP/i }).click();
  await page.getByLabel("Language").click();
  await page.getByRole("option", { name: /ESC\/POS/i }).click();
  await page.getByLabel(/address|host|port/i).fill("127.0.0.1:9100");
  await page.getByRole("button", { name: "Save printer" }).click();
  await expect(page.getByText('Added "E2E JetDirect"')).toBeVisible({
    timeout: 15_000,
  });

  // Case-insensitive duplicate: same name, different case.
  await openAdd(page);
  await page.getByLabel("Printer name").fill("e2e jetdirect");
  await page.getByLabel(/address|host|port/i).fill("127.0.0.1:9101");
  await page.getByRole("button", { name: "Save printer" }).click();
  await expect(page.getByText(/already exists/i)).toBeVisible({
    timeout: 15_000,
  });
  await page.keyboard.press("Escape");

  // Test print goes through the stubbed command and toasts.
  await page
    .getByRole("button", { name: "Test print on E2E JetDirect" })
    .click();
  await expect(page.getByText("Test page sent to E2E JetDirect")).toBeVisible({
    timeout: 15_000,
  });

  // Edit changes the address in place: no duplicate row, no re-add.
  await page.getByRole("button", { name: "Edit E2E JetDirect" }).click();
  await expect(page.getByRole("heading", { name: "Edit printer" })).toBeVisible();
  await page.getByLabel(/address|host|port/i).fill("127.0.0.1:9102");
  await page.getByRole("button", { name: "Save printer" }).click();
  await expect(page.getByText('Saved "E2E JetDirect"')).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByRole("button", { name: "Test print on E2E JetDirect" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Test print on E2E JetDirect" }),
  ).toHaveCount(1);

  // Remove asks first, then the row is gone.
  await page.getByRole("button", { name: "Remove E2E JetDirect" }).click();
  await page.getByRole("button", { name: "Remove printer" }).click();
  await expect(page.getByText('Removed "E2E JetDirect"')).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByRole("button", { name: "Test print on E2E JetDirect" }),
  ).toBeHidden();
});

test("printer validation rejects bad types, languages and unknown ids", async ({
  browser,
}) => {
  const seeded = await pc(browser, {});
  const page = await seeded.context.newPage();
  await page.goto("/printers");

  const invoke = (cmd: string, args: unknown) =>
    page.evaluate(
      ([c, a]) =>
        (
          window as unknown as {
            __TAURI_INTERNALS__: {
              invoke: (c: string, a: unknown) => Promise<unknown>;
            };
          }
        ).__TAURI_INTERNALS__.invoke(c, a),
      [cmd, args] as const,
    );

  await expect(
    invoke("add_printer", {
      req: {
        name: "Bad Type",
        printer_type: "carrier-pigeon",
        address: "x",
        language: "pdf",
      },
    }),
  ).rejects.toThrow(/Invalid printer type/);
  await expect(
    invoke("add_printer", {
      req: {
        name: "Bad Lang",
        printer_type: "ipp",
        address: "http://127.0.0.1/ipp/print",
        language: "hieroglyphs",
      },
    }),
  ).rejects.toThrow(/Invalid language/);
  await expect(
    invoke("add_printer", {
      req: { name: "   ", printer_type: "ipp", address: "x", language: "pdf" },
    }),
  ).rejects.toThrow(/name required/i);
  await expect(invoke("get_printer", { id: 424242 })).rejects.toThrow(
    /not found/,
  );
});
