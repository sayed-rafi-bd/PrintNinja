import { expect, test, type Browser, type Page } from "@playwright/test";
import { installAgent, pc } from "../support/fixtures";
import { testids } from "../support/testids";

// Accessibility + i18n floor (no axe in the harness): the app is
// English-only (index.html lang="en", i18next fallback en), so this
// pins rendered English instead of raw keys, a keyboard-only print
// path, small/large viewports without horizontal scroll, and a clean
// load under prefers-reduced-motion.

async function tabUntilFocused(
  page: Page,
  matches: (info: { role: string | null; name: string }) => boolean,
  maxTabs = 80,
): Promise<void> {
  for (let i = 0; i < maxTabs; i++) {
    const info: { role: string | null; name: string } = await page.evaluate(
      () => {
        const el = document.activeElement;
        return {
          role: el?.getAttribute("role") ?? null,
          name:
            el?.getAttribute("aria-label") ??
            el?.textContent?.slice(0, 40) ??
            "",
        };
      },
    );
    if (matches({ role: info.role, name: info.name })) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("never tabbed to the target control");
}

async function seededPc(
  browser: Browser,
  viewport?: { width: number; height: number },
) {
  const seeded = await pc(browser, {
    printers: [{ name: "E2E A11y Printer" }],
    templates: [
      {
        name: "A11y Label",
        server_id: crypto.randomUUID(),
        html: "<p>a11y</p>",
        sync_state: "synced",
      },
    ],
  });
  const page = await seeded.context.newPage();
  if (viewport) {
    await page.setViewportSize(viewport);
  }
  return { seeded, page };
}

test("html lang is English and key screens render no raw keys", async ({
  browser,
}) => {
  const { page } = await seededPc(browser);
  await page.goto("/");
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.lang))
    .toBe("en");

  for (const path of ["/print", "/templates", "/history", "/settings"]) {
    await page.goto(path);
    await expect(page.getByTestId(testids.shellApp)).toBeVisible({
      timeout: 15_000,
    });
    const rawKeys = await page.evaluate(() => {
      const text = document.body.innerText ?? "";
      // i18next renders the key itself when a translation is missing:
      // dotted lowercase tokens standing alone as words.
      const hits = text.match(/\b[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\b/g) ?? [];
      // Filter version numbers, product tokens and abbreviations.
      const legit = new Set(["e.g", "i.e", "etc", "vs"]);
      return hits.filter(
        (h) =>
          !legit.has(h) &&
          !h.includes("printninja") &&
          h.split(".").every((p) => /^[a-z][a-z0-9_]*$/.test(p)),
      );
    });
    expect(rawKeys, `raw i18n keys on ${path}: ${rawKeys.join(", ")}`).toEqual(
      [],
    );
  }
});

test("keyboard-only print path reaches the agent", async ({ browser }) => {
  const { page } = await seededPc(browser);
  await page.goto("/print");
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });

  // No mouse from here on: tab to each combobox, open it, type to
  // filter, confirm with Enter — the full keyboard path.
  await tabUntilFocused(
    page,
    (c) => c.role === "combobox" && /printer/i.test(c.name),
  );
  await page.keyboard.press("Enter");
  await page.keyboard.type("E2E A11y Printer");
  await page.keyboard.press("Enter");

  await tabUntilFocused(
    page,
    (c) => c.role === "combobox" && /template/i.test(c.name),
  );
  await page.keyboard.press("Enter");
  await page.keyboard.type("A11y Label");
  await page.keyboard.press("Enter");

  // Tab to the Print button and press it without touching the mouse.
  await tabUntilFocused(
    page,
    (c) => c.role === null && c.name.trim() === "Print",
  );
  await page.keyboard.press("Enter");

  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __FAKE_AGENT_CALLS: { cmd: string }[];
              }
            ).__FAKE_AGENT_CALLS.filter((c) => c.cmd === "print_html").length,
        ),
      { timeout: 15_000 },
    )
    .toBe(1);
});

test("small and large viewports do not scroll sideways", async ({
  browser,
}) => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    const { seeded, page } = await seededPc(browser, viewport);
    await page.goto("/print");
    await expect(page.getByTestId(testids.shellApp)).toBeVisible({
      timeout: 15_000,
    });
    const overflow = await page.evaluate(
      () => document.scrollingElement!.scrollWidth - window.innerWidth,
    );
    expect(overflow, `${viewport.width}px wide`).toBeLessThanOrEqual(1);
    await seeded.context.close();
  }
});

test("prefers-reduced-motion loads cleanly", async ({ browser }) => {
  const reduced = await browser.newContext({ reducedMotion: "reduce" });
  await installAgent(reduced, {});
  const page = await reduced.newPage();
  await page.goto("/");
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  await reduced.close();
});
