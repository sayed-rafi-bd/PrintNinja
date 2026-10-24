import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { installAgent } from "../support/fixtures";
import { apiRegister } from "../support/api";
import { readStackState } from "../support/stack-state";

// The phone smoke spec. Runs on the two
// mobile projects (Pixel 7 at 390x844, small at 360x640), where the
// coarse-pointer rules and card layouts apply. Every route gets the same
// four checks: no sideways scrolling, 44px tap targets, a review
// screenshot, and an axe pass.
//
// Refreshing baselines after an intentional visual change:
//   pnpm --filter e2e exec playwright test --project=mobile-pixel7 --update-snapshots

const ROUTES = [
  "/templates",
  "/print",
  "/printers",
  "/history",
  "/api-explorer",
  "/settings",
] as const;
// "/" rewrites to "/print" at boot (see startRoute.ts), so the Designer is
// covered separately below, through the real templates → Edit flow.

test.beforeEach(async ({ context }) => {
  // Same session shape as signedSeed, but on the project context so the
  // device viewport, touch, and mobile flags apply to every page.
  const auth = await apiRegister(
    `mobile-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    "password123",
  );
  await installAgent(context, {
    settings: {
      onboarding_done: "true",
      share_service_url: readStackState().apiUrl,
      share_session_token: auth.token,
    },
    templates: [
      {
        name: "Mobile Label",
        server_id: crypto.randomUUID(),
        html: "<p>mobile</p>",
        sync_state: "synced",
      },
    ],
    printers: [{ name: "Mobile Zebra" }],
  });
});

interface SmallTarget {
  tag: string;
  role: string;
  name: string;
  w: number;
  h: number;
  html: string;
}

// Known exceptions to the 44px rule, each with a reason. Everything else
// fails the spec. (Empty by default: prefer fixing the target. Entries
// added only after triage, with the reason recorded here.)
const TAP_ALLOW_LIST: Array<{
  tag: string;
  role: string;
  name: RegExp;
  reason: string;
}> = [
  // The toggle track keeps the platform switch shape (44 wide, 24 tall).
  { tag: "button", role: "switch", name: /.*/, reason: "toggle shape" },
];

async function checkRoute(
  page: import("@playwright/test").Page,
  label: string,
  shotName: string,
) {
  await expect(page.getByRole("main")).toBeVisible({ timeout: 15_000 });
  // Let debounced previews and share polling settle before measuring.
  await page.waitForTimeout(1000);

  // 1. Nothing scrolls sideways.
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    overflow.scrollWidth,
    `sideways scroll on ${label}: scrollWidth ${overflow.scrollWidth} > innerWidth ${overflow.innerWidth}`,
  ).toBeLessThanOrEqual(overflow.innerWidth);

  // 2. Every visible button, link and tab is thumb-sized.
  const small = await page.evaluate((): SmallTarget[] => {
    const out: SmallTarget[] = [];
    for (const el of document.querySelectorAll("button, a, [role='tab']")) {
      const r = el.getBoundingClientRect();
      // Clipped helpers (the 1px skip link) are not tap targets.
      if (r.width < 2 || r.height < 2) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      // Inline prose links are exempt from target size (WCAG 2.2).
      if (el.tagName.toLowerCase() === "a" && style.display === "inline")
        continue;
      if (
        typeof (el as Element).checkVisibility === "function" &&
        !(el as Element).checkVisibility()
      )
        continue;
      if (r.width < 44 || r.height < 44) {
        out.push({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          name: (el.getAttribute("aria-label") || el.textContent || "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 60),
          w: Math.round(r.width),
          h: Math.round(r.height),
          html: el.outerHTML.slice(0, 300),
        });
      }
    }
    return out;
  });
  const unexpected = small.filter(
    (s) =>
      !TAP_ALLOW_LIST.some(
        (a) => s.tag === a.tag && s.role === a.role && a.name.test(s.name),
      ),
  );
  expect(
    unexpected,
    `undersized tap targets on ${label}: ${JSON.stringify(unexpected)}`,
  ).toEqual([]);

  // 3. Review screenshot (Playwright appends project and platform).
  await expect(page).toHaveScreenshot(shotName, {
    animations: "disabled",
    caret: "initial",
    scale: "css",
    maxDiffPixelRatio: 0.02,
  });

  // 4. Axe at the phone viewport (same rule disables as the unit pass).
  // The sandboxed preview iframes hold generated template output, not
  // app chrome; axe cannot message into the opaque origin and hangs,
  // so they are excluded from the run.
  const results = await new AxeBuilder({ page })
    .disableRules(["color-contrast", "region"])
    .exclude("iframe[title='Canvas preview']")
    .exclude("iframe[title='Print preview']")
    .analyze();
  expect(
    results.violations.flatMap((v) =>
      v.nodes.map(
        (n) => `${v.id} @ ${n.target.join(" ")} :: ${n.html.slice(0, 500)}`,
      ),
    ),
    `axe violations on ${label}`,
  ).toEqual([]);
}

for (const route of ROUTES) {
  test(`phone checks pass on ${route}`, async ({ page }) => {
    await page.goto(route);
    await checkRoute(page, route, `${route.slice(1)}.png`);
  });
}

test("phone checks pass on the designer", async ({ page }) => {
  // "/" rewrites to "/print", so reach the Designer through the real
  // templates → Edit flow instead.
  await page.goto("/templates");
  await expect(page.getByRole("main")).toBeVisible({ timeout: 15_000 });
  await page
    .getByRole("button", { name: "Actions for Mobile Label" })
    .dispatchEvent("pointerdown");
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(page).toHaveURL(/\/template\/\d+/);
  await checkRoute(page, "designer", "designer.png");
});
