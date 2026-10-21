import { expect, test } from "@playwright/test";
import { apiMine, apiRegister } from "../support/api";
import { pc } from "../support/fixtures";
import { readStackState } from "../support/stack-state";
import { testids } from "../support/testids";

// F14 (REFACTORING.md section 11): first sync of a migrated install.
// The agent starts with local-only templates and one template whose
// server copy changed. The "back up N templates" dialog appears (ask
// once, allow decline). After confirming, the local-only ones are
// pushed private, and the changed one shows conflict instead of being
// overwritten.

const PASSWORD = "password123";

async function putTemplate(
  apiUrl: string,
  token: string,
  id: string,
  body: string,
  ifRevision?: number,
) {
  const response = await fetch(`${apiUrl}/v2/templates/${id}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "Changed",
      summary: "",
      page_w_mm: 210,
      page_h_mm: 297,
      language: "html",
      body,
      css: "",
      ...(ifRevision === undefined ? {} : { if_revision: ifRevision }),
    }),
  });
  if (!response.ok) {
    throw new Error(`PUT failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as { revision: number };
}

test("F14 first sync of a migrated install", async ({ browser }) => {
  test.setTimeout(240_000);
  const { apiUrl } = readStackState();
  const auth = await apiRegister(`f14-${Date.now().toString(36)}`, PASSWORD);

  // The server copy of a template this install tracked before the
  // cache existed; the local row carries a conflicting edit.
  const serverId = crypto.randomUUID();
  await putTemplate(apiUrl, auth.token, serverId, "<p>server copy</p>");

  const seeded = await pc(browser, {
    settings: { share_session_token: auth.token, install_migrated: "1" },
    templates: [
      { name: "Local one", html: "<p>mine 1</p>" },
      { name: "Local two", html: "<p>mine 2</p>" },
      {
        name: "Changed",
        server_id: serverId,
        html: "<p>local edit</p>",
        sync_state: "synced",
        server_revision: 1,
        base_revision: null,
      },
    ],
  });
  const page = await seeded.context.newPage();
  await page.goto("/templates");
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });

  // The backup dialog asks once with the local-only count.
  await expect(
    page.getByText("Back up 2 templates to the server?"),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Back up", exact: true }).click();
  await expect(page.getByText("Back up 2 templates to the server?")).toBeHidden(
    { timeout: 30_000 },
  );

  // The local-only templates are pushed private.
  await expect(async () => {
    const mine = await apiMine(auth.token);
    expect(mine.items.map((t) => t.name)).toEqual(
      expect.arrayContaining(["Local one", "Local two"]),
    );
    const privates = mine.items.filter(
      (t) => t.name === "Local one" || t.name === "Local two",
    );
    expect(privates.every((t) => t.published_at == null)).toBe(true);
  }).toPass({ timeout: 60_000 });

  // The changed row was not overwritten: it shows conflict, and the
  // server copy is untouched.
  await expect(page.getByTestId("conflict-banner")).toBeVisible({
    timeout: 30_000,
  });
  const kept = await page.evaluate(
    () =>
      JSON.parse(
        localStorage.getItem("fake-agent:templates") ?? "[]",
      ) as Array<{
        name: string;
        sync_state: string;
        versions: Array<{ html: string }>;
      }>,
  );
  expect(kept.find((t) => t.name === "Changed")).toMatchObject({
    sync_state: "conflict",
  });
  expect(kept.find((t) => t.name === "Changed")?.versions.at(-1)?.html).toBe(
    "<p>local edit</p>",
  );
});
