import { expect, test } from "@playwright/test";
import { apiMine, apiRegister } from "../support/api";
import { pc } from "../support/fixtures";
import { testids } from "../support/testids";

// F3 (REFACTORING.md section 11): A creates a template. Its cache row
// is dirty (pending), then the engine pushes it with no click and the
// server holds it private. B signs in with the same account and the
// template is in the list after the first pull — no "Get from server".
// Mutations go through IPC; UI creation is unit-covered, sync is what
// is pinned here.

async function createTemplate(page: import("@playwright/test").Page, name: string) {
	await page.evaluate(
		(n: string) =>
			(window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke(
				"create_template",
				{ req: { name: n, page_w_mm: 210, page_h_mm: 297, html: "<p>shared</p>", css: "" } },
			),
		name,
	);
}

test("F3 create on PC A appears on PC B", async ({ browser }) => {
	test.setTimeout(90_000);
	const handle = `f3-${Date.now().toString(36)}`;
	const password = "password123";
	const auth = await apiRegister(handle, password);

	const pcA = await pc(browser, { settings: { share_session_token: auth.token } });
	const pageA = await pcA.context.newPage();
	await pageA.goto("/templates");
	await expect(pageA.getByTestId(testids.shellApp)).toBeVisible({ timeout: 15_000 });

	await createTemplate(pageA, "Shared Idea");

	// The row waits in the cache first (pending).
	await expect(async () => {
		const rows = await pageA.evaluate(() =>
			JSON.parse(localStorage.getItem("fake-agent:templates") ?? "[]") as Array<{ sync_state: string }>,
		);
		expect(rows.map((r) => r.sync_state)).toContain("dirty");
	}).toPass({ timeout: 10_000 });

	// No click: the engine pushes on reload, the server holds it private.
	await pageA.reload();
	await expect(async () => {
		const mine = await apiMine(auth.token);
		expect(mine.items.map((t) => t.name)).toContain("Shared Idea");
	}).toPass({ timeout: 30_000 });

	// PC B signs in with the same account and pulls it with no extra step.
	const pcB = await pc(browser, { settings: { share_session_token: auth.token } });
	const pageB = await pcB.context.newPage();
	await pageB.goto("/templates");
	await expect(pageB.getByTestId(testids.shellApp)).toBeVisible({ timeout: 15_000 });
	await expect(pageB.getByText("Shared Idea")).toBeVisible({ timeout: 30_000 });
});

async function localTemplateId(page: import("@playwright/test").Page, name: string): Promise<number> {
	return page.evaluate(
		(n: string) =>
			(window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke(
				"list_templates",
				{},
			).then((rows) => (rows as Array<{ id: number; name: string }>).find((r) => r.name === n)?.id ?? -1),
		name,
	);
}

async function setupSharedTemplate(
	browser: import("@playwright/test").Browser,
	stem: string,
): Promise<{ token: string; auth: { token: string }; pcA: import("../support/fixtures").Pc; pageA: import("@playwright/test").Page }> {
	const { apiRegister } = await import("../support/api");
	const { pc } = await import("../support/fixtures");
	const handle = `${stem}-${Date.now().toString(36)}`;
	const password = "password123";
	const auth = await apiRegister(handle, password);
	const pcA = await pc(browser, { settings: { share_session_token: auth.token } });
	const pageA = await pcA.context.newPage();
	await pageA.goto("/templates");
	await expect(pageA.getByTestId(testids.shellApp)).toBeVisible({ timeout: 15_000 });
	await createTemplate(pageA, "Shared Idea");
	await pageA.reload();
	await expect(async () => {
		const { apiMine } = await import("../support/api");
		const mine = await apiMine(auth.token);
		expect(mine.items.map((t) => t.name)).toContain("Shared Idea");
	}).toPass({ timeout: 30_000 });
	return { token: auth.token, auth, pcA, pageA };
}

test("F4 edit on PC A reaches PC B with no manual refresh", async ({ browser }) => {
	test.setTimeout(120_000);
	const { token, pageA } = await setupSharedTemplate(browser, "f4");

	const { pc: pcFn } = await import("../support/fixtures");
	const pcB = await pcFn(browser, { settings: { share_session_token: token } });
	const pageB = await pcB.context.newPage();
	await pageB.goto("/templates");
	await expect(pageB.getByTestId(testids.shellApp)).toBeVisible({ timeout: 15_000 });
	await expect(pageB.getByText("Shared Idea")).toBeVisible({ timeout: 30_000 });

	// A edits the HTML and reloads to push.
	const idA = await localTemplateId(pageA, "Shared Idea");
	await pageA.evaluate(
		({ id }: { id: number }) =>
			(window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke(
				"create_version",
				{ req: { template_id: id, html: "<p>EDITED-V2</p>", css: "", created_by: "manual" } },
			),
		{ id: idA },
	);
	await pageA.reload();
	await expect(pageA.getByTestId(testids.shellApp)).toBeVisible({ timeout: 15_000 });

	// Wait for A's push to land server-side before B pulls: otherwise B
	// pulls the old revision and waits out the clock with nothing new.
	const remoteId: string = await pageA.evaluate(() =>
		(window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke(
			"list_templates",
			{},
		).then((rows) => (rows as Array<{ name: string; remote_id: string }>).find((r) => r.name === "Shared Idea")?.remote_id ?? ""),
	);
	await expect(async () => {
		const { apiVersions } = await import("../support/api");
		const versions = await apiVersions(token, remoteId);
		expect(Math.max(...versions.items.map((v) => v.version_no))).toBeGreaterThanOrEqual(2);
	}).toPass({ timeout: 30_000 });

	// B receives a focus event and the Print page uses the new content
	// without any Refresh click. Wait for the pull to land first: the
	// navigation below would otherwise mount Print on the stale cache.
	await pageB.evaluate(() => window.dispatchEvent(new Event("focus")));
	const idB = await localTemplateId(pageB, "Shared Idea");
	await expect(async () => {
		const versions = await pageB.evaluate(
			(id: number) =>
				(window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke(
					"list_versions",
					{ template_id: id },
				),
			idB,
		);
		expect((versions as Array<{ html: string }>).map((v) => v.html)).toContain("<p>EDITED-V2</p>");
	}).toPass({ timeout: 30_000 });
	await pageB.goto("/print");
	await pageB.getByRole("combobox", { name: "Template" }).click();
	await pageB.getByRole("option", { name: "Shared Idea" }).click();
	await expect(
		pageB.frameLocator('iframe[title="Print preview"]').getByText("EDITED-V2"),
	).toBeVisible({ timeout: 30_000 });
});

test("F5 delete on PC A removes the template on PC B", async ({ browser }) => {
	test.setTimeout(120_000);
	const { token, pageA } = await setupSharedTemplate(browser, "f5");

	const { pc: pcFn } = await import("../support/fixtures");
	const pcB = await pcFn(browser, { settings: { share_session_token: token } });
	const pageB = await pcB.context.newPage();
	await pageB.goto("/templates");
	await expect(pageB.getByTestId(testids.shellApp)).toBeVisible({ timeout: 15_000 });
	await expect(pageB.getByText("Shared Idea")).toBeVisible({ timeout: 30_000 });

	// A deletes and reloads to push the tombstone.
	const idA = await localTemplateId(pageA, "Shared Idea");
	await pageA.evaluate(
		(id: number) =>
			(window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke(
				"delete_template",
				{ id },
			),
		idA,
	);
	await pageA.reload();
	await expect(async () => {
		const { apiMine } = await import("../support/api");
		const mine = await apiMine(token);
		expect(mine.items.map((t) => t.name)).not.toContain("Shared Idea");
	}).toPass({ timeout: 30_000 });

	// B's next pull removes it from the list with no manual step.
	await pageB.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(pageB.getByText("Shared Idea")).toBeHidden({ timeout: 30_000 });
});
