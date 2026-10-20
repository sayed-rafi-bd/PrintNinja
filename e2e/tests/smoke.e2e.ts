import { expect, test } from "@playwright/test";
import { installAgent } from "../support/fixtures";
import { readStackState } from "../support/stack-state";
import { testids } from "../support/testids";

// The Phase 1 smoke spec (REFACTORING.md Phase 1): the app starts, the
// gate shows gate-unreachable when the API is down and signin-form when
// it is up. The "up" case answers the gate's /v2/health probe with
// route.fulfill (the documented suite technique), pinning the boot path,
// the agent settings path and the gate's rendering rather than the
// socket. The "down" case is fully real: a dead port, a refused
// connection, the unreachable screen.
test("gate shows gate-unreachable when the API is down", async ({
	page,
}) => {
	await installAgent(page, {
		settings: {
			onboarding_done: "true",
			// Discard port: nothing listens, the fetch refuses.
			share_service_url: "http://127.0.0.1:9",
			share_session_token: null,
		},
	});

	await page.goto("/");
	await expect(page.getByTestId(testids.gateUnreachable)).toBeVisible({
		timeout: 15_000,
	});
});

test("gate shows signin-form when the API is up", async ({ page }) => {
	const { apiUrl } = readStackState();
	await installAgent(page, {
		settings: {
			onboarding_done: "true",
			share_service_url: apiUrl,
			share_session_token: null,
		},
	});
	await page.route("**/health", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: '"ok"',
		}),
	);

	await page.goto("/");
	await expect(page.getByTestId(testids.signinForm)).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByTestId(testids.authHandle)).toBeVisible();
	await expect(page.getByTestId(testids.authPassword)).toBeVisible();

	const seen = await page.evaluate(
		() =>
			(
				window as unknown as {
					__FAKE_AGENT_CALLS: { cmd: string }[];
				}
			).__FAKE_AGENT_CALLS.map((c) => c.cmd),
	);
	expect(seen).toContain("get_setting");
});
