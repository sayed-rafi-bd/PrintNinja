import {
	ForbiddenError,
	NotFoundError,
	PayloadTooLargeError,
	RevisionConflictError,
	RevisionRequiredError,
	ValidationError,
} from "./errors.js";
import type { DatasetRepository, DatasetView } from "./libraryPorts.js";

/** Sample-dataset bodies are capped like CSS (unchecked UTF-16 length
 * would let multi-byte text past the budget — see P10). */
export const DATASET_JSON_MAX_BYTES = 262_144;

export interface PutDatasetInput {
	id: string;
	name: string;
	dataJson?: string;
	ifRevision?: number;
}

export interface PutDatasetResult {
	dataset: DatasetView;
	/** 201 when created, 200 when updated or replayed. */
	status: 201 | 200;
	/** True when a stale if_revision matched identical content and
	 * nothing was written. */
	replayed: boolean;
}

function checkWrite(input: PutDatasetInput): { name: string; dataJson: string } {
	const name = (input.name ?? "").trim();
	if (name.length === 0) {
		throw new ValidationError("Dataset name required", [{ path: "name", message: "Required" }]);
	}
	const dataJson = input.dataJson ?? "{}";
	if (Buffer.byteLength(dataJson, "utf8") > DATASET_JSON_MAX_BYTES) {
		throw new PayloadTooLargeError([
			{ path: "dataJson", message: `Over the ${DATASET_JSON_MAX_BYTES} byte cap` },
		]);
	}
	try {
		JSON.parse(dataJson);
	} catch {
		throw new ValidationError("data_json is not valid JSON", [
			{ path: "dataJson", message: "Must be valid JSON" },
		]);
	}
	return { name, dataJson };
}

/**
 * Creates or updates a sample dataset by client UUID. Updating without
 * if_revision is a 428; a stale one conflicts unless the content is
 * identical, in which case the lost response is replayed without
 * writing anything.
 */
export async function putDataset(
	repos: { datasets: DatasetRepository },
	input: PutDatasetInput,
	ownerId: string,
): Promise<PutDatasetResult> {
	const { name, dataJson } = checkWrite(input);
	const existing = await repos.datasets.findById(input.id);
	if (!existing) {
		const dataset = await repos.datasets.create({
			id: input.id,
			ownerId,
			name,
			dataJson,
		});
		return { dataset, status: 201, replayed: false };
	}
	if (existing.ownerId !== ownerId) {
		throw new ForbiddenError();
	}
	if (input.ifRevision === undefined) {
		throw new RevisionRequiredError();
	}
	if (input.ifRevision !== existing.revision) {
		if (existing.name === name && existing.dataJson === dataJson) {
			return { dataset: existing, status: 200, replayed: true };
		}
		throw new RevisionConflictError(existing.revision);
	}
	const dataset = await repos.datasets.update(
		{ id: input.id, ownerId, name, dataJson },
		input.ifRevision,
	);
	return { dataset, status: 200, replayed: false };
}

export async function deleteDataset(
	repos: { datasets: DatasetRepository },
	id: string,
	ownerId: string,
): Promise<void> {
	const existing = await repos.datasets.findById(id);
	if (!existing) {
		throw new NotFoundError();
	}
	if (existing.ownerId !== ownerId) {
		throw new ForbiddenError();
	}
	await repos.datasets.deleteWithTombstone(id);
}
