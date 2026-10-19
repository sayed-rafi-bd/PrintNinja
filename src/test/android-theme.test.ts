import { describe, it, expect } from "vitest";
// @ts-expect-error plain .mjs script without types
import { patchThemes } from "../../scripts/patch-android-theme.mjs";

const SAMPLE = `<resources xmlns:tools="http://schemas.android.com/tools">
    <style name="Theme.printninja" parent="Theme.MaterialComponents.DayNight.NoActionBar">
        <!-- Customize your theme here. -->
    </style>
</resources>`;

describe("patch-android-theme", () => {
  const out = patchThemes(SAMPLE) as string;
  it("uses a light parent theme", () => {
    expect(out).toContain("Theme.MaterialComponents.Light.NoActionBar");
    expect(out).not.toContain("DayNight");
  });
  it("sets light status and navigation bars", () => {
    expect(out).toContain('<item name="android:statusBarColor">#FFFFFF</item>');
    expect(out).toContain('<item name="android:windowLightStatusBar">true</item>');
    expect(out).toContain('<item name="android:windowLightNavigationBar">true</item>');
  });
  it("is idempotent", () => {
    expect(patchThemes(out)).toBe(out);
  });
});
