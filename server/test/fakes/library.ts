import {
	NotFoundError,
	RevisionConflictError,
	RevisionRequiredError,
} from "../../src/domain/errors.js";
import type {
	DatasetRepository,
	DatasetView,
	ProfileRepository,
	ProfileView,
} from "../../src/domain/libraryPorts.js";

// In-memory dataset and profile repositories (REFACTORING.md section 5).
// Mirror the Prisma implementations: revision checks, sequence bumps
// and tombstones with the entity name the sync stream filters on.
export interface FakeLibraryStore {
	datasets: Map<string, DatasetView & { ownerHandle?: string }>;
	profiles: Map<string, ProfileView>;
	seqs: Map<string, bigint>;
	tombstones: { userId: string; seq: bigint; entity: string; entityKey: string; deletedAt: Date }[];
	tick: number;
}

const BASE_MS = new Date("2026-10-20T00:00:00Z").getTime();

export function createFakeLibraryRepos(): {
	datasets: DatasetRepository;
	profiles: ProfileRepository;
	store: FakeLibraryStore;
} {
	const store: FakeLibraryStore = {
		datasets: new Map(),
		profiles: new Map(),
		seqs: new Map(),
		tombstones: [],
		tick: 0,
	};

	const now = () => new Date(BASE_MS + store.tick++ * 1000);
	const bumpSeq = (userId: string): bigint => {
		const next = (store.seqs.get(userId) ?? 1n) + 1n;
		store.seqs.set(userId, next);
		return next;
	};

	const datasets: DatasetRepository = {
		async findById(id) {
			return store.datasets.get(id) ?? null;
		},
		async create(input) {
			if (store.datasets.has(input.id)) {
				throw new RevisionRequiredError();
			}
			const timestamp = now();
			const stored: DatasetView = {
				id: input.id,
				ownerId: input.ownerId,
				name: input.name,
				dataJson: input.dataJson,
				revision: 1,
				changeSeq: bumpSeq(input.ownerId),
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			store.datasets.set(stored.id, stored);
			return stored;
		},
		async update(input, expectedRevision) {
			const stored = store.datasets.get(input.id) ?? null;
			if (!stored) {
				throw new NotFoundError();
			}
			if (stored.revision !== expectedRevision) {
				throw new RevisionConflictError(stored.revision);
			}
			Object.assign(stored, {
				name: input.name,
				dataJson: input.dataJson,
				revision: stored.revision + 1,
				changeSeq: bumpSeq(stored.ownerId),
				updatedAt: now(),
			});
			return stored;
		},
		async deleteWithTombstone(id) {
			const stored = store.datasets.get(id) ?? null;
			if (!stored) {
				return null;
			}
			store.tombstones.push({
				userId: stored.ownerId,
				seq: bumpSeq(stored.ownerId),
				entity: "dataset",
				entityKey: id,
				deletedAt: now(),
			});
			store.datasets.delete(id);
			return { ownerId: stored.ownerId };
		},
		async listByOwner(ownerId) {
			return [...store.datasets.values()]
				.filter((d) => d.ownerId === ownerId)
				.sort((a, b) => (a.name < b.name ? -1 : 1));
		},
	};

	const profiles: ProfileRepository = {
		async findById(id) {
			return store.profiles.get(id) ?? null;
		},
		async create(input) {
			if (store.profiles.has(input.id)) {
				throw new RevisionRequiredError();
			}
			const timestamp = now();
			const stored: ProfileView = {
				id: input.id,
				ownerId: input.ownerId,
				templateId: input.templateId,
				printerName: input.printerName,
				settingsJson: input.settingsJson,
				revision: 1,
				changeSeq: bumpSeq(input.ownerId),
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			store.profiles.set(stored.id, stored);
			return stored;
		},
		async update(input, expectedRevision) {
			const stored = store.profiles.get(input.id) ?? null;
			if (!stored) {
				throw new NotFoundError();
			}
			if (stored.revision !== expectedRevision) {
				throw new RevisionConflictError(stored.revision);
			}
			Object.assign(stored, {
				templateId: input.templateId,
				printerName: input.printerName,
				settingsJson: input.settingsJson,
				revision: stored.revision + 1,
				changeSeq: bumpSeq(stored.ownerId),
				updatedAt: now(),
			});
			return stored;
		},
		async deleteWithTombstone(id) {
			const stored = store.profiles.get(id) ?? null;
			if (!stored) {
				return null;
			}
			store.tombstones.push({
				userId: stored.ownerId,
				seq: bumpSeq(stored.ownerId),
				entity: "profile",
				entityKey: id,
				deletedAt: now(),
			});
			store.profiles.delete(id);
			return { ownerId: stored.ownerId };
		},
		async listByOwner(ownerId) {
			return [...store.profiles.values()]
				.filter((p) => p.ownerId === ownerId)
				.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
		},
	};

	return { datasets, profiles, store };
}
