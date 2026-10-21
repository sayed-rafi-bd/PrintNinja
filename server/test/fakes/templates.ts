import {
  NotFoundError,
  RevisionConflictError,
  RevisionRequiredError,
} from "../../src/domain/errors.js";
import { toPage } from "../../src/domain/pagination.js";
import type { SyncEntity, SyncRepository } from "../../src/domain/syncPorts.js";
import type {
  CommunitySort,
  PageQuery,
  SavedRepository,
  TemplateRecord,
  TemplateRepository,
  TemplateSummaryView,
  TemplateView,
} from "../../src/domain/templatePorts.js";

// In-memory template and saved repositories (REFACTORING.md section 5).
// These mirror the Prisma implementations exactly — sort orders,
// tie-breaks, visibility rules, revision and sequence handling — because
// the repository contract suite runs the same behaviors against both,
// and any disagreement fails the build. Ordering uses a monotonic
// logical clock so rapid writes stay deterministic; wall time is a
// production detail the contract never asserts.

interface StoredVersion {
  versionNo: number;
  body: string;
  css: string;
  createdBy: string;
  label?: string;
  note?: string;
}

interface StoredTemplate extends TemplateRecord {
  ownerHandle: string;
  versions: StoredVersion[];
}

interface SavedRow {
  templateId: string;
  addedAt: Date;
}

export interface FakeTemplateStore {
  templates: Map<string, StoredTemplate>;
  seqs: Map<string, bigint>;
  tombstones: {
    userId: string;
    seq: bigint;
    entity: string;
    entityKey: string;
    deletedAt: Date;
  }[];
  saved: Map<string, SavedRow[]>;
  tick: number;
}

const BASE_MS = new Date("2026-10-20T00:00:00Z").getTime();

export function createFakeTemplateRepos(users: {
  byId: Map<string, { handle: string }>;
}): {
  templates: TemplateRepository;
  saved: SavedRepository;
  sync: SyncRepository;
  store: FakeTemplateStore;
} {
  const store: FakeTemplateStore = {
    templates: new Map(),
    seqs: new Map(),
    tombstones: [],
    saved: new Map(),
    tick: 0,
  };

  const now = () => new Date(BASE_MS + store.tick++ * 1000);
  // Mirrors user_sync.next_seq (@default(1)) with bump-then-hand: the
  // first number handed out is 2n in both implementations.
  const bumpSeq = (userId: string): bigint => {
    const next = (store.seqs.get(userId) ?? 1n) + 1n;
    store.seqs.set(userId, next);
    return next;
  };
  const pruneAutosaves = (templateId: string): void => {
    const stored = store.templates.get(templateId);
    if (!stored) {
      return;
    }
    const autosaves = stored.versions
      .filter((v) => v.createdBy === "autosave")
      .sort((a, b) => a.versionNo - b.versionNo);
    if (autosaves.length > 50) {
      const drop = new Set(
        autosaves.slice(0, autosaves.length - 50).map((v) => v.versionNo),
      );
      stored.versions = stored.versions.filter((v) => !drop.has(v.versionNo));
    }
  };

  const handleOf = (ownerId: string): string => {
    const user = users.byId.get(ownerId);
    if (!user) {
      throw new NotFoundError();
    }
    return user.handle;
  };

  const toView = (stored: StoredTemplate): TemplateView => ({
    ...recordOf(stored),
    ownerHandle: stored.ownerHandle,
    versionCount: stored.versions.length,
  });

  const toSummary = (stored: StoredTemplate): TemplateSummaryView => ({
    id: stored.id,
    ownerId: stored.ownerId,
    ownerHandle: stored.ownerHandle,
    name: stored.name,
    summary: stored.summary,
    pageWMm: stored.pageWMm,
    pageHMm: stored.pageHMm,
    language: stored.language,
    useCount: stored.useCount,
    revision: stored.revision,
    versionCount: stored.versions.length,
    publishedAt: stored.publishedAt,
    updatedAt: stored.updatedAt,
  });

  const compareUpdated = (a: StoredTemplate, b: StoredTemplate) =>
    b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? -1 : 1);
  const compareUsed = (a: StoredTemplate, b: StoredTemplate) =>
    b.useCount - a.useCount ||
    b.updatedAt.getTime() - a.updatedAt.getTime() ||
    (a.id < b.id ? -1 : 1);
  const compareName = (a: StoredTemplate, b: StoredTemplate) =>
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1);

  const sortFor = (sort: CommunitySort) =>
    sort === "used"
      ? compareUsed
      : sort === "name"
        ? compareName
        : compareUpdated;

  function estimateSize(
    candidate:
      | { kind: "upsert"; template: StoredTemplate }
      | { kind: "delete" },
  ): number {
    if (candidate.kind === "delete") {
      return 100;
    }
    const t = candidate.template;
    return (
      Buffer.byteLength(t.body, "utf8") +
      Buffer.byteLength(t.css, "utf8") +
      Buffer.byteLength(t.readme, "utf8") +
      Buffer.byteLength(t.name, "utf8") +
      Buffer.byteLength(t.summary, "utf8") +
      500
    );
  }

  const paginate = (
    rows: StoredTemplate[],
    query: PageQuery,
    map: (stored: StoredTemplate) => TemplateSummaryView = toSummary,
  ) =>
    toPage(
      rows
        .slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
        .map(map),
      rows.length,
      query,
    );

  const templates: TemplateRepository = {
    async findById(id) {
      const stored = store.templates.get(id) ?? null;
      return stored && toView(stored);
    },

    async create(input, version) {
      if (store.templates.has(input.id)) {
        // Mirrors the P2002 mapping: the row now exists, so the
        // caller retries as an update.
        throw new RevisionRequiredError();
      }
      const timestamp = now();
      const stored: StoredTemplate = {
        ...input,
        ownerHandle: handleOf(input.ownerId),
        useCount: 0,
        revision: 1,
        changeSeq: bumpSeq(input.ownerId),
        publishedAt: null,
        firstPublishedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        versions: [
          {
            versionNo: 1,
            body: input.body,
            css: input.css,
            createdBy: version.createdBy,
            ...(version.label !== undefined ? { label: version.label } : {}),
            ...(version.note !== undefined ? { note: version.note } : {}),
          },
        ],
      };
      store.templates.set(stored.id, stored);
      pruneAutosaves(stored.id);
      return toView(stored);
    },

    async update(input, expectedRevision, version) {
      const stored = store.templates.get(input.id) ?? null;
      if (!stored) {
        throw new NotFoundError();
      }
      if (stored.revision !== expectedRevision) {
        throw new RevisionConflictError(stored.revision);
      }
      const nextRevision = version ? stored.revision + 1 : stored.revision;
      Object.assign(stored, {
        ...input,
        revision: nextRevision,
        changeSeq: bumpSeq(stored.ownerId),
        updatedAt: now(),
      });
      if (version) {
        const maxNo = stored.versions.reduce(
          (m, v) => Math.max(m, v.versionNo),
          0,
        );
        stored.versions.push({
          versionNo: maxNo + 1,
          body: input.body,
          css: input.css,
          createdBy: version.createdBy,
          ...(version.label !== undefined ? { label: version.label } : {}),
          ...(version.note !== undefined ? { note: version.note } : {}),
        });
        pruneAutosaves(stored.id);
      }
      return toView(stored);
    },

    async setPublished(id, publishedAt) {
      const stored = store.templates.get(id) ?? null;
      if (!stored) {
        return null;
      }
      if (publishedAt === null) {
        stored.publishedAt = null;
      } else {
        const first = stored.firstPublishedAt ?? publishedAt;
        stored.firstPublishedAt = first;
        stored.publishedAt = first;
      }
      stored.changeSeq = bumpSeq(stored.ownerId);
      stored.updatedAt = now();
      return toView(stored);
    },

    async deleteWithTombstone(id) {
      const stored = store.templates.get(id) ?? null;
      if (!stored) {
        return null;
      }
      store.tombstones.push({
        userId: stored.ownerId,
        seq: bumpSeq(stored.ownerId),
        entity: "template",
        entityKey: id,
        deletedAt: now(),
      });
      // Saved rows survive on purpose: the manifest reports them as
      // deleted (E14). Only versions cascade with the template.
      store.templates.delete(id);
      return { ownerId: stored.ownerId };
    },

    async listVersions(templateId, query) {
      const stored = store.templates.get(templateId) ?? null;
      if (!stored) {
        return toPage([], 0, query);
      }
      const rows = [...stored.versions].sort(
        (a, b) => b.versionNo - a.versionNo,
      );
      const items = rows
        .slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
        .map((v) => ({
          versionNo: v.versionNo,
          createdBy: v.createdBy as "manual" | "autosave" | "restore",
          label: v.label ?? null,
          note: v.note ?? null,
          createdAt: new Date(BASE_MS),
        }));
      return toPage(items, rows.length, query);
    },

    async findVersion(templateId, versionNo) {
      const stored = store.templates.get(templateId) ?? null;
      const v =
        stored?.versions.find((row) => row.versionNo === versionNo) ?? null;
      return (
        v && {
          templateId,
          versionNo: v.versionNo,
          body: v.body,
          css: v.css,
          createdBy: v.createdBy as "manual" | "autosave" | "restore",
          label: v.label ?? null,
          note: v.note ?? null,
          createdAt: new Date(BASE_MS),
        }
      );
    },

    async deleteVersion(templateId, versionNo) {
      const stored = store.templates.get(templateId) ?? null;
      if (!stored || stored.versions.length === 0) {
        return "missing";
      }
      const max = stored.versions.reduce((m, v) => Math.max(m, v.versionNo), 0);
      if (max === versionNo) {
        return "newest";
      }
      const index = stored.versions.findIndex((v) => v.versionNo === versionNo);
      if (index < 0) {
        return "missing";
      }
      stored.versions.splice(index, 1);
      return "deleted";
    },

    async listByOwner(ownerId, query) {
      const rows = [...store.templates.values()]
        .filter((t) => t.ownerId === ownerId)
        .sort(compareUpdated);
      return paginate(rows, query);
    },

    async listPublished(query) {
      const q = query.q?.trim().toLowerCase();
      const rows = [...store.templates.values()]
        .filter((t) => t.publishedAt !== null)
        .filter(
          (t) =>
            !q ||
            t.name.toLowerCase().includes(q) ||
            t.summary.toLowerCase().includes(q) ||
            t.ownerHandle.toLowerCase().includes(q),
        )
        .sort(sortFor(query.sort));
      return paginate(rows, query);
    },

    async incrementUseCount(id, by) {
      const stored = store.templates.get(id) ?? null;
      if (!stored || stored.publishedAt === null) {
        return false;
      }
      stored.useCount += by;
      return true;
    },
  };

  const saved: SavedRepository = {
    async list(userId, query) {
      const rows = (store.saved.get(userId) ?? [])
        .map((row) => ({
          row,
          template: store.templates.get(row.templateId) ?? null,
        }))
        .filter(
          (entry): entry is { row: SavedRow; template: StoredTemplate } =>
            entry.template !== null && entry.template.publishedAt !== null,
        )
        .sort(
          (a, b) =>
            b.row.addedAt.getTime() - a.row.addedAt.getTime() ||
            (a.template.id < b.template.id ? -1 : 1),
        );
      const items = rows.map((entry) => toSummary(entry.template));
      return toPage(
        items.slice(
          (query.page - 1) * query.pageSize,
          query.page * query.pageSize,
        ),
        items.length,
        query,
      );
    },

    async countByUser(userId) {
      return (store.saved.get(userId) ?? []).length;
    },

    async save(userId, templateId) {
      const rows = store.saved.get(userId) ?? [];
      if (!rows.some((row) => row.templateId === templateId)) {
        rows.push({ templateId, addedAt: now() });
        store.saved.set(userId, rows);
      }
    },

    async unsave(userId, templateId) {
      const rows = store.saved.get(userId) ?? [];
      const index = rows.findIndex((row) => row.templateId === templateId);
      if (index >= 0) {
        rows.splice(index, 1);
      }
    },

    async listManifest(userId) {
      const rows = [...(store.saved.get(userId) ?? [])].sort(
        (a, b) =>
          b.addedAt.getTime() - a.addedAt.getTime() ||
          (a.templateId < b.templateId ? -1 : 1),
      );
      return rows.map((row) => {
        const template = store.templates.get(row.templateId) ?? null;
        if (template) {
          return {
            templateId: row.templateId,
            addedAt: row.addedAt,
            template: toView(template),
            deletedAt: null,
          };
        }
        const tomb = store.tombstones.find(
          (t) =>
            t.userId === userId &&
            t.entity === "template" &&
            t.entityKey === row.templateId,
        );
        return {
          templateId: row.templateId,
          addedAt: row.addedAt,
          template: null,
          deletedAt: tomb?.deletedAt ?? null,
        };
      });
    },
  };

  const sync: SyncRepository = {
    async tombstoneFloor(userId) {
      const seqs = store.tombstones
        .filter((t) => t.userId === userId)
        .map((t) => t.seq);
      return seqs.length === 0 ? 0n : seqs.reduce((m, v) => (v < m ? v : m));
    },
    async readSince(userId, query, byteBudget) {
      type Candidate =
        | { seq: bigint; kind: "upsert"; template: StoredTemplate }
        | {
            seq: bigint;
            kind: "delete";
            entity: SyncEntity;
            entityKey: string;
          };
      const candidates: Candidate[] = [];
      if (query.types.includes("template")) {
        for (const t of store.templates.values()) {
          if (t.ownerId === userId && t.changeSeq > query.cursor) {
            candidates.push({ seq: t.changeSeq, kind: "upsert", template: t });
          }
        }
      }
      for (const t of store.tombstones) {
        if (
          t.userId === userId &&
          t.seq > query.cursor &&
          query.types.includes(t.entity as SyncEntity)
        ) {
          candidates.push({
            seq: t.seq,
            kind: "delete",
            entity: t.entity as SyncEntity,
            entityKey: t.entityKey,
          });
        }
      }
      candidates.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
      const hasMoreProbe = candidates.length > query.limit;
      const page = candidates.slice(0, query.limit);
      let used = 0;
      let kept = page.length;
      for (let i = 0; i < page.length; i += 1) {
        const size = estimateSize(page[i]);
        if (used + size > byteBudget && i > 0) {
          kept = i;
          break;
        }
        used += size;
      }
      const trimmed = page.slice(0, kept);
      return {
        changes: trimmed.map((c) =>
          c.kind === "delete"
            ? { seq: c.seq, entity: c.entity, entityKey: c.entityKey }
            : {
                seq: c.seq,
                entity: "template",
                data: toView(c.template),
                headVersionNo: c.template.versions.reduce(
                  (m, v) => Math.max(m, v.versionNo),
                  0,
                ),
              },
        ),
        nextCursor:
          trimmed.length > 0 ? trimmed[trimmed.length - 1].seq : query.cursor,
        hasMore: hasMoreProbe || kept < page.length,
      };
    },
    async purgeTombstones(olderThan) {
      const before = store.tombstones.length;
      const cutoff = olderThan.getTime();
      store.tombstones = store.tombstones.filter(
        (t) => t.deletedAt.getTime() > cutoff,
      );
      return before - store.tombstones.length;
    },
  };

  return { templates, saved, sync, store };
}

function recordOf(stored: StoredTemplate): TemplateRecord {
  return {
    id: stored.id,
    ownerId: stored.ownerId,
    name: stored.name,
    summary: stored.summary,
    pageWMm: stored.pageWMm,
    pageHMm: stored.pageHMm,
    language: stored.language,
    body: stored.body,
    css: stored.css,
    readme: stored.readme,
    useCount: stored.useCount,
    revision: stored.revision,
    changeSeq: stored.changeSeq,
    publishedAt: stored.publishedAt,
    firstPublishedAt: stored.firstPublishedAt,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}
