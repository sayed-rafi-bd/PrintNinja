import { expect, test } from "@playwright/test";
import { pc } from "../support/fixtures";
import { readStackState } from "../support/stack-state";
import { testids } from "../support/testids";

// F1 (REFACTORING.md section 11): register on the sign-in screen and
// reach the shell; wrong passwords stay on the form with the error; a
// handle that differs only by case is "already in use" (409); sign out
// returns to sign-in and signing in again reopens the app.

test("F1 sign up, sign in, case-duplicate, sign out, sign in again", async ({ browser }) => {
	const { apiUrl } = readStackState();
	const handle = `F1User${Date.now().toString(36)}`;
	const password = "password123";
	const seeded = await pc(browser);
	const page = await seeded.context.newPage();
	await page.goto("/");
	await expect(page.getByTestId(testids.signinForm)).toBeVisible({ timeout: 15_000 });

	// Register a new account.
	await page.getByTestId(testids.authUrl).fill(apiUrl);
	await page.getByTestId(testids.authHandle).fill(handle);
	await page.getByTestId(testids.authPassword).fill(password);
	await page.getByRole("button", { name: "New here? Create an account" }).click();
	await page.getByRole("button", { name: "Create account" }).click();
	await expect(page.getByTestId(testids.shellApp)).toBeVisible({ timeout: 15_000 });

	// Sign out returns to sign-in.
	await page.goto("/settings");
	await page.getByRole("tab", { name: "Share" }).click();
	await page.getByRole("button", { name: "Sign out" }).click();
	await expect(page.getByTestId(testids.signinForm)).toBeVisible({ timeout: 15_000 });

	// Wrong password shows the error and stays on the form.
	await page.getByTestId(testids.authHandle).fill(handle);
	await page.getByTestId(testids.authPassword).fill("wrong-password");
	await page.getByRole("button", { name: "Sign in" }).click();
	await expect(page.getByText("Invalid handle or password")).toBeVisible({ timeout: 10_000 });
	await expect(page.getByTestId(testids.signinForm)).toBeVisible();

	// A handle that differs only by case is already in use (409).
	await page.getByRole("button", { name: "New here? Create an account" }).click();
	await page.getByTestId(testids.authHandle).fill(handle.toLowerCase());
	await page.getByTestId(testids.authPassword).fill(password);
	await page.getByRole("button", { name: "Create account" }).click();
	await expect(page.getByText("Handle already taken")).toBeVisible({ timeout: 10_000 });
	await expect(page.getByTestId(testids.signinForm)).toBeVisible();

	// Signing in again reopens the app.
	await page.getByRole("button", { name: "Already have an account? Sign in" }).click();
	await page.getByTestId(testids.authHandle).fill(handle);
	await page.getByTestId(testids.authPassword).fill(password);
	await page.getByRole("button", { name: "Sign in" }).click();
	await expect(page.getByTestId(testids.shellApp)).toBeVisible({ timeout: 15_000 });
});
