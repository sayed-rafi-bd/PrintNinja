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
export const DATASET_NAME_MAX_BYTES = 200;
/** Nesting budget: a 256 KiB deeply-nested array would blow the sync
 * estimator's recursion and each reader's stack. 32 is far beyond any
 * real template context shape. */
export const DATASET_JSON_MAX_DEPTH = 32;

/** Iterative depth of a parsed JSON value (scalars count 0). */
export function jsonDepth(value: unknown): number {
  let max = 0;
  const stack: Array<{ node: unknown; depth: number }> = [
    { node: value, depth: 0 },
  ];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as {
      node: unknown;
      depth: number;
    };
    if (depth > max) max = depth;
    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, depth: depth + 1 });
    } else if (node !== null && typeof node === "object") {
      for (const item of Object.values(node))
        stack.push({ node: item, depth: depth + 1 });
    }
  }
  return max;
}

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

function checkWrite(input: PutDatasetInput): {
  name: string;
  dataJson: string;
} {
  const name = (input.name ?? "").trim();
  if (name.length === 0) {
    throw new ValidationError("Dataset name required", [
      { path: "name", message: "Required" },
    ]);
  }
  if (Buffer.byteLength(name, "utf8") > DATASET_NAME_MAX_BYTES) {
    throw new PayloadTooLargeError([
      {
        path: "name",
        message: `Over the ${DATASET_NAME_MAX_BYTES} byte cap`,
      },
    ]);
  }
  const dataJson = input.dataJson ?? "{}";
  if (Buffer.byteLength(dataJson, "utf8") > DATASET_JSON_MAX_BYTES) {
    throw new PayloadTooLargeError([
      {
        path: "dataJson",
        message: `Over the ${DATASET_JSON_MAX_BYTES} byte cap`,
      },
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataJson);
  } catch {
    throw new ValidationError("data_json is not valid JSON", [
      { path: "dataJson", message: "Must be valid JSON" },
    ]);
  }
  if (jsonDepth(parsed) > DATASET_JSON_MAX_DEPTH) {
    throw new ValidationError("data_json is nested too deeply", [
      {
        path: "dataJson",
        message: `Must nest at most ${DATASET_JSON_MAX_DEPTH} levels`,
      },
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
