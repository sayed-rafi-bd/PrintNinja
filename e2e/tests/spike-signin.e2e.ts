import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fakeAgent = fileURLToPath(
  new URL("../support/fake-agent.mjs", import.meta.url),
);

// Phase 1 spike, item 4: the fake agent answers `get_setting` through
// `window.__TAURI_INTERNALS__` and the app, served by Vite, renders the
// sign-in screen. The assertion doubles as the shape proof: if the shim were
// wrong, the swallowed invoke error would leave the gate on onboarding or the
// spinner instead of the sign-in form.
test("the app boots through the fake agent to the sign-in screen", async ({
  page,
}) => {
  await page.addInitScript({ path: fakeAgent });

  await page.goto("/");
  await expect(page.locator("#auth-handle")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#auth-password")).toBeVisible();

  const calls = await page.evaluate(
    () =>
      (window as unknown as { __FAKE_AGENT_CALLS: { cmd: string }[] })
        .__FAKE_AGENT_CALLS.map((c) => c.cmd),
  );
  expect(calls).toContain("get_setting");
});
