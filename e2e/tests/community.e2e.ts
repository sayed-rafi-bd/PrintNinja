import { expect, test } from "@playwright/test";
import { apiCommunity, apiMine, apiRegister } from "../support/api";
import { pc } from "../support/fixtures";
import { testids } from "../support/testids";

// F7 (REFACTORING.md section 11): A publishes. B finds the template in
// Community by search and sort, saves it, and sees it in Saved as
// read-only. A unpublishes and B's copy shows "Withdrawn by author"
// after the next pull. A republishes and it is available again.

test("F7 publish, find, save, withdraw, republish", async ({ browser }) => {
	test.setTimeout(240_000);
	const password = "password123";
	const auth = await apiRegister(`f7-${Date.now().toString(36)}`, password);
	const pcA = await pc(browser, { settings: { share_session_token: auth.token } });
	const pageA = await pcA.context.newPage();
	await pageA.goto("/templates");
	await expect(pageA.getByTestId(testids.shellApp)).toBeVisible({ timeout: 15_000 });
	await pageA.evaluate((n: string) =>
		(window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke(
			"create_template",
			{ req: { name: n, page_w_mm: 210, page_h_mm: 297, html: "<p>community gem</p>", css: "" } },
		),
		"Community Gem",
	);
	await pageA.reload();

	// A publishes from the Designer.
	const idA: number = await pageA.evaluate(() =>
		(window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke("list_templates", {},
		).then((rows) => (rows as Array<{ id: number; name: string }>).find((r) => r.name === "Community Gem")?.id ?? -1),
	);
	await pageA.goto(`/template/${idA}`);
	await pageA.getByTestId(testids.templatePublish).click();
	await expect(async () => {
		const community = await apiCommunity(auth.token, "Community Gem");
		expect(community.items.map((t) => t.name)).toContain("Community Gem");
	}).toPass({ timeout: 30_000 });

	// B finds it in Community by search and sort, saves it, and sees it
	// in Saved as read-only.
	// B (a different account — the community is public) finds it by
	// search and sort, saves it, and sees it in Saved as read-only.
	const authB = await apiRegister(`f7b-${Date.now().toString(36)}`, password);
	const pcB = await pc(browser, { settings: { share_session_token: authB.token } });
	const pageB = await pcB.context.newPage();
	await pageB.goto("/templates");
	await expect(pageB.getByTestId(testids.shellApp)).toBeVisible({ timeout: 15_000 });
	await pageB.getByRole("tab", { name: /Community/ }).click({ timeout: 15_000 });
	await pageB.getByPlaceholder("Search by name").fill("Community Gem");
	await pageB.getByLabel("Sort templates").click();
	await pageB.getByRole("option", { name: "Most used" }).click();
	await expect(pageB.getByText("Community Gem")).toBeVisible({ timeout: 30_000 });
	const card = pageB.locator("li:visible", { hasText: "Community Gem" });
	await card.getByRole("button", { name: "Save", exact: true }).click({ timeout: 15000 });
	await expect(pageB.getByText("Community Gem").first()).toBeVisible({ timeout: 30_000 });
	await pageB.getByRole("tab", { name: /Saved/ }).click();
	const savedTable = pageB.getByRole("table", { name: "Saved templates" });
	const savedRow = savedTable.getByText("Community Gem");
	await expect(savedRow).toBeVisible({ timeout: 30_000 });
	// Saved copies are read-only: no Edit action on the row.
	const savedTr = savedRow.locator("xpath=ancestor::tr[1]");
	await expect(savedTr.getByRole("button", { name: /Edit/ })).toHaveCount(0);

	// A unpublishes; B's copy shows "Withdrawn by author" after the pull.
	await pageA.bringToFront();
	await pageA.getByTestId(testids.templateUnpublish).click();
	const dialog = pageA.getByRole("dialog");
	await dialog.getByRole("button", { name: "Unpublish", exact: true }).click({ timeout: 15000 });
	await expect(async () => {
		const community = await apiCommunity(auth.token, "Community Gem");
		expect(community.items.map((t) => t.name)).not.toContain("Community Gem");
	}).toPass({ timeout: 30_000 });
	await pageB.bringToFront();
	await pageB.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(pageB.getByText("Withdrawn by author")).toBeVisible({ timeout: 30_000 });

	// A republishes and it is available again.
	await pageA.bringToFront();
	await pageA.getByTestId(testids.templatePublish).click();
	await expect(async () => {
		const community = await apiCommunity(auth.token, "Community Gem");
		expect(community.items.map((t) => t.name)).toContain("Community Gem");
	}).toPass({ timeout: 30_000 });
	await pageB.bringToFront();
	// A reload pulls unconditionally (window focus is throttled to once a
	// minute, and the withdraw check already spent this minute's focus).
	// Tabs reset to Mine, so go back to Saved first.
	await pageB.reload();
	await expect(pageB.getByTestId(testids.shellApp)).toBeVisible({ timeout: 15_000 });
	await pageB.getByRole("tab", { name: /Saved/ }).click();
	await expect(pageB.getByText("Withdrawn by author")).toBeHidden({ timeout: 30_000 });
});
