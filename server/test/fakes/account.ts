import {
  NotFoundError,
  RevisionConflictError,
  RevisionRequiredError,
} from "../../src/domain/errors.js";
import type {
  FontRepository,
  FontView,
  SettingRepository,
  SettingView,
} from "../../src/domain/libraryPorts.js";

// In-memory settings and fonts (REFACTORING.md section 5). Mirror the
// Prisma repositories: revision checks, tombstones, quotas.
interface StoredSetting extends SettingView {}

interface StoredFont extends FontView {
  bytes: Uint8Array | null;
}

export interface FakeAccountStore {
  settings: Map<string, StoredSetting>;
  fonts: Map<string, StoredFont>;
  seqs: Map<string, bigint>;
  tombstones: {
    userId: string;
    seq: bigint;
    entity: string;
    entityKey: string;
    deletedAt: Date;
  }[];
  tick: number;
}

const BASE_MS = new Date("2026-10-20T00:00:00Z").getTime();

export function createFakeAccountRepos(): {
  settings: SettingRepository;
  fonts: FontRepository;
  store: FakeAccountStore;
} {
  const store: FakeAccountStore = {
    settings: new Map(),
    fonts: new Map(),
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
  const settingKey = (ownerId: string, key: string) => `${ownerId}\n${key}`;

  const settings: SettingRepository = {
    async findByKey(ownerId, key) {
      return store.settings.get(settingKey(ownerId, key)) ?? null;
    },
    async create(input) {
      if (store.settings.has(settingKey(input.ownerId, input.key))) {
        throw new RevisionRequiredError();
      }
      const stored: StoredSetting = {
        ownerId: input.ownerId,
        key: input.key,
        value: input.value,
        revision: 1,
        changeSeq: bumpSeq(input.ownerId),
        updatedAt: now(),
      };
      store.settings.set(settingKey(input.ownerId, input.key), stored);
      return stored;
    },
    async update(input, expectedRevision) {
      const stored =
        store.settings.get(settingKey(input.ownerId, input.key)) ?? null;
      if (!stored) {
        throw new NotFoundError();
      }
      if (stored.revision !== expectedRevision) {
        throw new RevisionConflictError(stored.revision);
      }
      Object.assign(stored, {
        value: input.value,
        revision: stored.revision + 1,
        changeSeq: bumpSeq(stored.ownerId),
        updatedAt: now(),
      });
      return stored;
    },
    async deleteWithTombstone(ownerId, key) {
      const stored = store.settings.get(settingKey(ownerId, key)) ?? null;
      if (!stored) {
        return false;
      }
      store.tombstones.push({
        userId: ownerId,
        seq: bumpSeq(ownerId),
        entity: "setting",
        entityKey: key,
        deletedAt: now(),
      });
      store.settings.delete(settingKey(ownerId, key));
      return true;
    },
    async listByOwner(ownerId) {
      return [...store.settings.values()]
        .filter((s) => s.ownerId === ownerId)
        .sort((a, b) => (a.key < b.key ? -1 : 1));
    },
  };

  const fonts: FontRepository = {
    async findById(id) {
      const stored = store.fonts.get(id) ?? null;
      if (!stored) {
        return null;
      }
      const { bytes: _bytes, ...view } = stored;
      return view;
    },
    async findFile(id) {
      const stored = store.fonts.get(id) ?? null;
      if (!stored || stored.bytes === null) {
        return null;
      }
      const { bytes, ...view } = stored;
      return { ...view, bytes };
    },
    async countByOwner(ownerId) {
      return [...store.fonts.values()].filter((f) => f.ownerId === ownerId)
        .length;
    },
    async create(input) {
      if (store.fonts.has(input.id)) {
        throw new RevisionRequiredError();
      }
      const timestamp = now();
      const stored: StoredFont = {
        id: input.id,
        ownerId: input.ownerId,
        name: input.name,
        format: "",
        sizeBytes: 0,
        sha256: "",
        revision: 1,
        changeSeq: bumpSeq(input.ownerId),
        createdAt: timestamp,
        updatedAt: timestamp,
        bytes: null,
      };
      store.fonts.set(stored.id, stored);
      const { bytes: _bytes, ...view } = stored;
      return view;
    },
    async updateName(input, expectedRevision) {
      const stored = store.fonts.get(input.id) ?? null;
      if (!stored) {
        throw new NotFoundError();
      }
      if (stored.revision !== expectedRevision) {
        throw new RevisionConflictError(stored.revision);
      }
      Object.assign(stored, {
        name: input.name,
        revision: stored.revision + 1,
        changeSeq: bumpSeq(stored.ownerId),
        updatedAt: now(),
      });
      const { bytes: _bytes, ...view } = stored;
      return view;
    },
    async replaceFile(input) {
      const stored = store.fonts.get(input.id) ?? null;
      if (!stored) {
        throw new NotFoundError();
      }
      Object.assign(stored, {
        format: input.format,
        sizeBytes: input.bytes.length,
        sha256: input.sha256,
        revision: stored.revision + 1,
        changeSeq: bumpSeq(stored.ownerId),
        updatedAt: now(),
        bytes: input.bytes,
      });
      return { ...stored, bytes: input.bytes };
    },
    async deleteWithTombstone(id) {
      const stored = store.fonts.get(id) ?? null;
      if (!stored) {
        return null;
      }
      store.tombstones.push({
        userId: stored.ownerId,
        seq: bumpSeq(stored.ownerId),
        entity: "font",
        entityKey: id,
        deletedAt: now(),
      });
      store.fonts.delete(id);
      return { ownerId: stored.ownerId };
    },
    async listByOwner(ownerId) {
      return [...store.fonts.values()]
        .filter((f) => f.ownerId === ownerId)
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map(({ bytes: _bytes, ...view }) => view);
    },
  };

  return { settings, fonts, store };
}
