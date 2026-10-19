// Makes the generated Android project use the light palette: light status and
// navigation bars instead of the DayNight default. Run after `tauri android init`.
//   node scripts/patch-android-theme.mjs [path/to/android/app/src/main/res]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BAR = "#FFFFFF"; // matches the top bar (`card`)
const ITEMS = [
  ["android:statusBarColor", BAR],
  ["android:navigationBarColor", BAR],
  ["android:windowLightStatusBar", "true"],
  ["android:windowLightNavigationBar", "true"],
];

/** Pure and idempotent: returns the patched XML. */
export function patchThemes(xml) {
  // One light theme only: DayNight would follow the phone's dark mode.
  let out = xml.replace(/Theme\.(MaterialComponents|AppCompat|Material3)\.DayNight/g, "Theme.$1.Light");
  const m = out.match(/<style\b[^>]*>/);
  if (!m) return out;
  const missing = ITEMS.filter(([name]) => !out.includes(`name="${name}"`));
  if (missing.length === 0) return out;
  const lines = missing.map(([n, v]) => `        <item name="${n}">${v}</item>`).join("\n");
  const at = out.indexOf(m[0]) + m[0].length;
  return `${out.slice(0, at)}\n${lines}${out.slice(at)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const res = process.argv[2] ?? "src-tauri/gen/android/app/src/main/res";
  let patched = 0;
  for (const dir of ["values", "values-night"]) {
    const file = join(res, dir, "themes.xml");
    if (!existsSync(file)) continue;
    const before = readFileSync(file, "utf8");
    const after = patchThemes(before);
    if (after !== before) writeFileSync(file, after);
    patched++;
    console.log(`${file}: ${after !== before ? "patched" : "already up to date"}`);
  }
  if (patched === 0) {
    console.error(`No themes.xml found under ${res}. Run \`pnpm exec tauri android init\` first.`);
    process.exit(1);
  }
}
