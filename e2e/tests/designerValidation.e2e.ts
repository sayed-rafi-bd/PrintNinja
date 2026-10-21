import { expect, test, type Page } from "@playwright/test";
import { pc } from "../support/fixtures";
import { testids } from "../support/testids";

// Designer validation paths: the same rules the Rust backend enforces
// (commands/template.rs + version.rs, mirrored in the fake agent) are
// surfaced in the UI as toasts, not silent failures.

async function invoke(
  page: Page,
  cmd: string,
  args: unknown,
): Promise<unknown> {
  return page.evaluate(
    ({ c, a }: { c: string; a: unknown }) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (c: string, a: unknown) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__.invoke(c, a),
    { c: cmd, a: args },
  );
}

async function templateIdByName(page: Page, name: string): Promise<number> {
  return (await invoke(page, "list_templates", {}).then(
    (rows) =>
      (rows as Array<{ id: number; name: string }>).find((r) => r.name === name)
        ?.id ?? -1,
  )) as number;
}

test("designer rejects duplicates, blanks and remote references", async ({
  browser,
}) => {
  const seeded = await pc(browser, {});
  const page = await seeded.context.newPage();
  await page.goto("/templates");

  await invoke(page, "create_template", {
    req: {
      name: "Taken",
      page_w_mm: 210,
      page_h_mm: 297,
      html: "<p>v1</p>",
      css: "",
    },
  });

  // Duplicate and blank names fail at create time.
  await expect(
    invoke(page, "create_template", {
      req: {
        name: "taken",
        page_w_mm: 210,
        page_h_mm: 297,
        html: "<p>x</p>",
        css: "",
      },
    }),
  ).rejects.toThrow(/already exists/);
  await expect(
    invoke(page, "create_template", {
      req: {
        name: "   ",
        page_w_mm: 210,
        page_h_mm: 297,
        html: "<p>x</p>",
        css: "",
      },
    }),
  ).rejects.toThrow(/name required/i);

  // A remote image passes the editor but the save is refused with the
  // backend's message, and the working copy is untouched.
  const id = await templateIdByName(page, "Taken");
  expect(id).toBeGreaterThan(0);
  await page.goto(`/template/${id}`);
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type('<p>ok</p><img src="http://evil.example/x.png">', {
    delay: 5,
  });
  await page.getByTestId(testids.designerSave).click();
  await expect(page.getByText(/remote references/i)).toBeVisible({
    timeout: 15_000,
  });
});
