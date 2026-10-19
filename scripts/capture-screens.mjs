// Captures every route at desktop and phone width for before/after review.
// Usage:  pnpm dev   (in another terminal)
//         node scripts/capture-screens.mjs [outDir] [--dpi]
// Needs:  npx playwright install chromium   (one-off)
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const base = process.env.BASE_URL ?? "http://localhost:1420";
const out = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "docs/ui-baseline";
const routes = ["/", "/templates", "/print", "/printers", "/history", "/settings"];
// Default: the two baseline sizes. `--dpi` instead captures what a 1920×1080 and a
// 1366×768 Windows display show at 125% and 150% scaling (CSS pixels = physical / scale).
const dpi = process.argv.includes("--dpi");
const sizes = dpi
  ? [
      { name: "1080p-125", width: 1536, height: 864, deviceScaleFactor: 1.25 },
      { name: "1080p-150", width: 1280, height: 720, deviceScaleFactor: 1.5 },
      { name: "768p-125", width: 1093, height: 614, deviceScaleFactor: 1.25 },
      { name: "768p-150", width: 911, height: 512, deviceScaleFactor: 1.5 },
    ]
  : [
      { name: "desktop", width: 1440, height: 900 },
      { name: "phone", width: 390, height: 844 },
    ];

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
for (const size of sizes) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.deviceScaleFactor ?? 1 });
  const page = await ctx.newPage();
  // Skip first-run onboarding so every route is reachable.
  await page.addInitScript(() => localStorage.setItem("printninja-onboarding-complete", "true"));
  for (const route of routes) {
    await page.goto(base + route, { waitUntil: "networkidle" });
    const name = route === "/" ? "designer" : route.slice(1);
    await page.screenshot({ path: `${out}/${name}-${size.name}.png`, fullPage: false });
    console.log(`${out}/${name}-${size.name}.png`);
  }
  await ctx.close();
}
await browser.close();
