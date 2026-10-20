import { describe, expect, it } from "vitest";
import {
	ForbiddenError,
	NotFoundError,
	RevisionConflictError,
	RevisionRequiredError,
} from "../src/domain/errors.js";
import type { DatasetRepository, ProfileRepository } from "../src/domain/libraryPorts.js";
import { deleteDataset, putDataset } from "../src/domain/datasets.js";
import { deleteProfile, putProfile } from "../src/domain/profiles.js";
import { createFakeLibraryRepos } from "./fakes/library.js";

const OWNER_ID = "owner-1";
const OTHER_ID = "other-1";

function repos(): { datasets: DatasetRepository; profiles: ProfileRepository } {
	const { datasets, profiles } = createFakeLibraryRepos();
	return { datasets, profiles };
}

describe("putDataset", () => {
	it("creates with revision 1 and a fresh sequence", async () => {
		const r = repos();
		const res = await putDataset(
			r,
			{ id: "11111111-1111-4111-8111-111111111111", name: "Orders", dataJson: '{"rows":[]}' },
			OWNER_ID,
		);
		expect(res.status).toBe(201);
		expect(res.dataset.revision).toBe(1);
		expect(res.dataset.changeSeq).toBe(2n);
		expect(res.replayed).toBe(false);
	});

	it("updates with if_revision and bumps the revision", async () => {
		const r = repos();
		await putDataset(r, { id: "d1", name: "O", dataJson: "{}" }, OWNER_ID);
		const res = await putDataset(r, { id: "d1", name: "O2", dataJson: '{"a":1}', ifRevision: 1 }, OWNER_ID);
		expect(res.status).toBe(200);
		expect(res.dataset.revision).toBe(2);
		expect(res.dataset.name).toBe("O2");
	});

	it("refuses updates without if_revision and stale revisions", async () => {
		const r = repos();
		await putDataset(r, { id: "d1", name: "O", dataJson: "{}" }, OWNER_ID);
		await expect(putDataset(r, { id: "d1", name: "X", dataJson: "{}" }, OWNER_ID)).rejects.toBeInstanceOf(
			RevisionRequiredError,
		);
		await expect(
			putDataset(r, { id: "d1", name: "X", dataJson: "{}", ifRevision: 99 }, OWNER_ID),
		).rejects.toBeInstanceOf(RevisionConflictError);
	});

	it("replays identical content without writing", async () => {
		const r = repos();
		await putDataset(r, { id: "d1", name: "O", dataJson: '{"a":1}' }, OWNER_ID);
		const res = await putDataset(r, { id: "d1", name: "O", dataJson: '{"a":1}', ifRevision: 99 }, OWNER_ID);
		expect(res.status).toBe(200);
		expect(res.replayed).toBe(true);
		const after = await r.datasets.findById("d1");
		expect(after?.revision).toBe(1);
	});

	it("rejects bad JSON, oversize bodies and other owners", async () => {
		const r = repos();
		await expect(putDataset(r, { id: "d1", name: "O", dataJson: "{nope" }, OWNER_ID)).rejects.toThrow(
			/not valid JSON/,
		);
		await expect(
			putDataset(r, { id: "d1", name: "O", dataJson: `"${"x".repeat(300_000)}"` }, OWNER_ID),
		).rejects.toThrow(/cap/i);
		await putDataset(r, { id: "d2", name: "O", dataJson: "{}" }, OWNER_ID);
		await expect(putDataset(r, { id: "d2", name: "X", dataJson: "{}", ifRevision: 1 }, OTHER_ID)).rejects.toBeInstanceOf(
			ForbiddenError,
		);
		await expect(deleteDataset(r, "missing", OWNER_ID)).rejects.toBeInstanceOf(NotFoundError);
		await expect(deleteDataset(r, "d2", OTHER_ID)).rejects.toBeInstanceOf(ForbiddenError);
	});

	it("deletes with a tombstone and lists by owner", async () => {
		const r = repos();
		await putDataset(r, { id: "d1", name: "B", dataJson: "{}" }, OWNER_ID);
		await putDataset(r, { id: "d2", name: "A", dataJson: "{}" }, OWNER_ID);
		await deleteDataset(r, "d1", OWNER_ID);
		const remaining = await r.datasets.listByOwner(OWNER_ID);
		expect(remaining.map((d) => d.id)).toEqual(["d2"]);
	});
});

describe("putProfile", () => {
	it("creates keyed by template and lowercase printer name", async () => {
		const r = repos();
		const res = await putProfile(
			r,
			{ id: "11111111-1111-4111-8111-111111111111", templateId: "aaaaaaaa-1111-4111-8111-111111111111", printerName: "E2E Label Printer", settingsJson: '{"dark":true}' },
			OWNER_ID,
		);
		expect(res.status).toBe(201);
		expect(res.profile.printerName).toBe("e2e label printer");
		expect(res.profile.revision).toBe(1);
	});

	it("updates with if_revision, conflicts when stale, replays when identical", async () => {
		const r = repos();
		const input = { id: "p1", templateId: "aaaaaaaa-1111-4111-8111-111111111111", printerName: "E2E", settingsJson: '{"a":1}' };
		await putProfile(r, input, OWNER_ID);
		const updated = await putProfile(r, { ...input, settingsJson: '{"a":2}', ifRevision: 1 }, OWNER_ID);
		expect(updated.status).toBe(200);
		expect(updated.profile.revision).toBe(2);
		await expect(putProfile(r, { ...input, ifRevision: 1 }, OWNER_ID)).rejects.toBeInstanceOf(RevisionConflictError);
		await expect(putProfile(r, { ...input, ifRevision: 99 }, OWNER_ID)).rejects.toBeInstanceOf(RevisionConflictError);
		const replayed = await putProfile(r, { ...input, settingsJson: '{"a":2}', ifRevision: 99 }, OWNER_ID);
		expect(replayed.replayed).toBe(true);
	});

	it("rejects other owners and missing rows", async () => {
		const r = repos();
		await putProfile(r, { id: "p1", templateId: "aaaaaaaa-1111-4111-8111-111111111111", printerName: "E2E", settingsJson: "{}" }, OWNER_ID);
		await expect(
			putProfile(r, { id: "p1", templateId: "aaaaaaaa-1111-4111-8111-111111111111", printerName: "E2E", settingsJson: "{}", ifRevision: 1 }, OTHER_ID),
		).rejects.toBeInstanceOf(ForbiddenError);
		await expect(deleteProfile(r, "missing", OWNER_ID)).rejects.toBeInstanceOf(NotFoundError);
	});
});
