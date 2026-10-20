import { expect, test } from "@playwright/test";
import { apiRegister } from "../support/api";
import { pc } from "../support/fixtures";
import { readStackState } from "../support/stack-state";
import { testids } from "../support/testids";

// F13 (REFACTORING.md section 11): on the Print page, selecting a
// template and a printer and filling the form causes zero requests to
// the API. Printing never waits for, starts or retries a sync — the
// spec never presses print-submit.

test("F13 no network at print time", async ({ browser }) => {
	const { apiUrl } = readStackState();
	const auth = await apiRegister(`f13-${Date.now().toString(36)}`, "password123");
	const seeded = await pc(browser, {
		settings: { share_session_token: auth.token },
		templates: [{ name: "F13 Label", server_id: crypto.randomUUID(), html: "<p>f13</p>", sync_state: "synced" }],
		printers: [{ name: "E2E Label Printer" }],
	});
	const page = await seeded.context.newPage();
	await page.goto("/print");
	await expect(page.getByTestId(testids.shellApp)).toBeVisible({ timeout: 15_000 });
	// The seeded printer and template arrive through the fake agent.
	await page.getByRole("combobox", { name: "Printer" }).click();
	await expect(page.getByRole("option", { name: "E2E Label Printer" })).toBeVisible();
	await page.keyboard.press("Escape");

	// Only requests from here on count: the gate and the lists above may
	// use the network, the print interaction itself must not.
	const apiHits: string[] = [];
	await page.route("**/*", (route) => {
		if (route.request().url().startsWith(apiUrl)) {
			apiHits.push(`${route.request().method()} ${route.request().url().replace(apiUrl, "")}`);
		}
		return route.continue();
	});

	await page.getByRole("combobox", { name: "Printer" }).click();
	await page.getByRole("option", { name: "E2E Label Printer" }).click();
	await page.getByRole("combobox", { name: "Template" }).click();
	await page.getByRole("option", { name: "F13 Label" }).click();
	await page.getByLabel("Data URL").fill("https://example.test/order/42");
	await page.getByLabel("Copies").fill("2");

	// Let any debounced or background work flush, then assert silence.
	await page.waitForTimeout(3000);
	expect(apiHits).toEqual([]);
});
