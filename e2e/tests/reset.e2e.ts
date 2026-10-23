import { expect, test } from "@playwright/test";
import {
  apiMine,
  apiPutDataset,
  apiPutTemplate,
  apiRegister,
  apiSyncChanges,
} from "../support/api";
import { pc } from "../support/fixtures";
import { readStackState } from "../support/stack-state";
import { testids } from "../support/testids";

// Full local reset (Settings → Retention → Reset): everything the app
// owns on the PC is wiped and the app returns to sign-in — while the
// account on the server is untouched. Signing back in on the same PC
// pulls it all down again. Mutations go through IPC; the dialog flow,
// the server isolation and the re-pull are what is pinned here.

test("reset wipes the PC, keeps the server copy, and re-pulls on sign-in", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const handle = `reset-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const password = "password123";
  const auth = await apiRegister(handle, password);

  const pcA = await pc(browser, {
    settings: { share_session_token: auth.token },
  });
  const page = await pcA.context.newPage();
  await page.goto("/templates");
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });

  const invoke = (cmd: string, args?: unknown) =>
    page.evaluate(
      ([c, a]) =>
        (
          window as unknown as {
            __TAURI_INTERNALS__: {
              invoke: (cmd: string, args?: unknown) => Promise<unknown>;
            };
          }
        ).__TAURI_INTERNALS__.invoke(c, a),
      [cmd, args] as const,
    ) as Promise<unknown>;

  // Seed one of everything the wipe claims to clear, straight on the
  // server; the PC pulls it all down before the wipe.
  await apiPutTemplate(auth.token, crypto.randomUUID(), {
    name: "Keep Me",
    body: "<p>x</p>",
  });
  await apiPutDataset(auth.token, crypto.randomUUID(), {
    name: "Keep Data",
    dataJson: '{"rows":[]}',
  });
  await page.reload();
  await expect(async () => {
    const mine = await apiMine(auth.token);
    expect(mine.items.map((t) => t.name)).toContain("Keep Me");
  }).toPass({ timeout: 30_000 });
  await expect(async () => {
    const changes = await apiSyncChanges(auth.token, "dataset");
    expect(
      changes.changes.filter(
        (c) => c.entity === "dataset" && c.op === "upsert",
      ),
    ).toHaveLength(1);
  }).toPass({ timeout: 30_000 });

  // Retention tab → Reset this PC → confirm.
  await page.goto("/settings");
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("tab", { name: "Retention" }).click();
  await page.getByTestId(testids.settingsResetDatabase).click();
  await expect(page.getByText("Erase everything on this PC?")).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "Erase everything" }).click();

  // The wipe reloads into the sign-in gate: the token is gone too.
  // (The fake agent's call log resets on reload, so the emptied caches
  // below are the proof the wipe ran — nothing else clears them.)
  await expect(page.getByTestId(testids.signinForm)).toBeVisible({
    timeout: 15_000,
  });

  // Every cache is empty and the session is gone.
  expect(await invoke("list_templates", {})).toEqual([]);
  expect(await invoke("list_datasets", {})).toEqual([]);
  expect(await invoke("list_fonts", {})).toEqual([]);
  expect(
    await invoke("get_setting", { key: "share_session_token" }),
  ).toBeNull();

  // The server copy survived the wipe untouched.
  const mine = await apiMine(auth.token);
  expect(mine.items.map((t) => t.name)).toContain("Keep Me");
  const changes = await apiSyncChanges(auth.token, "dataset");
  expect(
    changes.changes.filter((c) => c.entity === "dataset" && c.op === "upsert"),
  ).toHaveLength(1);

  // Signing back in on the same PC pulls it all down again. The wipe
  // also cleared the server address, so it is entered like on a fresh
  // install before signing in.
  await page.getByTestId(testids.authUrl).fill(readStackState().apiUrl);
  await page.getByTestId(testids.authHandle).fill(handle);
  await page.getByTestId(testids.authPassword).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
  // Sign-in keeps the current route (/settings); the template renders
  // on /templates, which pulls and refreshes on arrival.
  await page.goto("/templates");
  await expect(page.getByText("Keep Me")).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    const rows = (await invoke("list_datasets", {})) as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toContain("Keep Data");
  }).toPass({ timeout: 30_000 });
});
