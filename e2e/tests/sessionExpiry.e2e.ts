import { expect, test } from "@playwright/test";
import { apiLogin, apiLogout, apiRegister } from "../support/api";
import { pc } from "../support/fixtures";
import { testids } from "../support/testids";

// F2 (REFACTORING.md section 11): another client ends the session. The
// next sync gets 401, the sign-in screen appears with the session-ended
// notice, and the unsaved edit is still in the cache after signing in
// again.

test("F2 session ends while working", async ({ browser }) => {
  const handle = `f2-${Date.now().toString(36)}`;
  const password = "password123";
  const auth = await apiRegister(handle, password);
  const seeded = await pc(browser, {
    settings: { share_session_token: auth.token },
    templates: [
      {
        name: "Unfinished",
        server_id: crypto.randomUUID(),
        html: "<p>draft</p>",
        sync_state: "synced",
      },
    ],
  });
  const page = await seeded.context.newPage();
  await page.goto("/templates");
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });

  // An unsaved local edit sits in the cache.
  await page.evaluate(() =>
    (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__.invoke("create_version", {
      req: {
        template_id: 1,
        html: "<p>unsaved edit</p>",
        css: "",
        created_by: "manual",
      },
    }),
  );

  // Another client logs the session out; the next sync (window focus)
  // gets 401 and the gate shows the session-ended notice.
  await apiLogout(auth.token);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByTestId(testids.signinForm)).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByText("Your session ended. Sign in again to keep working."),
  ).toBeVisible();

  // Signing in again reopens the app with the edit still cached.
  await page.getByTestId(testids.authHandle).fill(handle);
  await page.getByTestId(testids.authPassword).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  const cached = await page.evaluate(
    () =>
      JSON.parse(
        localStorage.getItem("fake-agent:templates") ?? "[]",
      ) as Array<{
        name: string;
        sync_state: string;
        versions: Array<{ html: string }>;
      }>,
  );
  const unfinished = cached.find((t) => t.name === "Unfinished");
  expect(unfinished).toBeDefined();
  expect(unfinished?.sync_state).toBe("dirty");
  expect(unfinished?.versions.at(-1)?.html).toBe("<p>unsaved edit</p>");

  // The new session works: the token the form stored authenticates.
  const me = await apiLogin(handle, password);
  expect(me.user.handle).toBe(handle);
});
