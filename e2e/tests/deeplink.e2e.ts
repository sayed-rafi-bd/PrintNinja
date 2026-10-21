import { expect, test, type Page } from "@playwright/test";
import { pc } from "../support/fixtures";

// Deep-link contract: parse_deeplink answers the same shapes as the
// Rust parser (src-tauri/src/deeplink.rs, contract table
// parse_deep_link_contract_table). There is no OS handoff in the
// harness — the app resolves links through this command, so the spec
// pins the parse half against the fake implementation.

async function parse(page: Page, url: string): Promise<unknown> {
  return page.evaluate(
    (u: string) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (c: string, a: unknown) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__.invoke("parse_deeplink", { url: u }),
    url,
  );
}

test("deeplinks parse print, open and template actions", async ({
  browser,
}) => {
  const seeded = await pc(browser, {});
  const page = await seeded.context.newPage();
  await page.goto("/");

  const print = (await parse(
    page,
    "printninja://print?template=My+Receipt&printer=Desk&copies=3&test=1",
  )) as {
    Print: {
      template: string | null;
      printer: string | null;
      copies: number | null;
      test: boolean;
      confirm: boolean;
      callback: string | null;
    };
  };
  expect(print.Print.template).toBe("My Receipt");
  expect(print.Print.printer).toBe("Desk");
  expect(print.Print.copies).toBe(3);
  expect(print.Print.test).toBe(true);
  expect(print.Print.confirm).toBe(true);
  expect(print.Print.callback).toBeNull();

  const open = (await parse(page, "printninja://open/history")) as {
    Open: string;
  };
  expect(open).toEqual({ Open: "history" });

  const template = (await parse(page, "printninja://template/abc-123")) as {
    Template: string;
  };
  expect(template).toEqual({ Template: "abc-123" });

  await expect(parse(page, "printninja://explode/now")).rejects.toThrow(
    /Unknown deep link action/,
  );
});

test("deeplinks drop garbage copies and honor confirm/callback", async ({
  browser,
}) => {
  const seeded = await pc(browser, {});
  const page = await seeded.context.newPage();
  await page.goto("/");

  const garbage = (await parse(page, "printninja://print?copies=lots")) as {
    Print: { copies: number | null };
  };
  expect(garbage.Print.copies).toBeNull();

  const negative = (await parse(page, "printninja://print?copies=-3")) as {
    Print: { copies: number | null };
  };
  expect(negative.Print.copies).toBeNull();

  const overflow = (await parse(
    page,
    "printninja://print?copies=99999999999",
  )) as { Print: { copies: number | null } };
  expect(overflow.Print.copies).toBeNull();

  const withCallback = (await parse(
    page,
    "printninja://print?callback=https%3A%2F%2Fexample.com%2Fdone&confirm=0",
  )) as { Print: { confirm: boolean; callback: string | null } };
  expect(withCallback.Print.confirm).toBe(false);
  expect(withCallback.Print.callback).toBe("https://example.com/done");
});
