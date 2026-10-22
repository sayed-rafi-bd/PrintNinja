import type { Page } from "./pagination.js";

// Template library ports (REFACTORING.md section 5/7). Repositories are
// deliberately thin: the domain decides, the repository executes each
// mutation atomically (revision check, row write, version append and
// sequence-number take happen in one transaction).

export interface TemplateRecord {
  id: string;
  ownerId: string;
  name: string;
  summary: string;
  pageWMm: number;
  pageHMm: number;
  language: string;
  body: string;
  css: string;
  readme: string;
  useCount: number;
  revision: number;
  changeSeq: bigint;
  publishedAt: Date | null;
  firstPublishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TemplateView extends TemplateRecord {
  ownerHandle: string;
  versionCount: number;
}

export type VersionCreatedBy = "manual" | "autosave" | "restore";

export interface VersionView {
  templateId: string;
  versionNo: number;
  body: string;
  css: string;
  createdBy: VersionCreatedBy;
  label: string | null;
  note: string | null;
  createdAt: Date;
}

export interface VersionSummaryView {
  versionNo: number;
  createdBy: VersionCreatedBy;
  label: string | null;
  note: string | null;
  createdAt: Date;
}

export interface TemplateSummaryView {
  id: string;
  ownerId: string;
  ownerHandle: string;
  name: string;
  summary: string;
  pageWMm: number;
  pageHMm: number;
  language: string;
  useCount: number;
  revision: number;
  versionCount: number;
  publishedAt: Date | null;
  updatedAt: Date;
}

export interface TemplateWrite {
  id: string;
  ownerId: string;
  name: string;
  summary: string;
  pageWMm: number;
  pageHMm: number;
  language: string;
  body: string;
  css: string;
  readme: string;
  /** Import-only: preserved file timestamps. Absent means now. */
  createdAt?: Date;
  updatedAt?: Date;
}

export interface VersionWrite {
  createdBy: "manual" | "autosave" | "restore";
  label?: string;
  note?: string;
}

export interface PageQuery {
  page: number;
  pageSize: number;
}

export type CommunitySort = "updated" | "used" | "name";

export interface PublishedQuery extends PageQuery {
  q?: string;
  sort: CommunitySort;
}

export interface TemplateRepository {
  findById(id: string): Promise<TemplateView | null>;
  /** Creates the row with revision 1, a version 1 and a fresh sequence
   * number, atomically. A duplicate id (a retried create racing the
   * first) reports revision_required: the row now exists, so the
   * caller retries as an update. */
  create(input: TemplateWrite, version: VersionWrite): Promise<TemplateView>;
  /** Checks expectedRevision, writes the row, bumps the revision and
   * appends a version only when version is given (content change),
   * takes a fresh sequence number either way. Throws
   * RevisionConflictError with the stored revision on mismatch. */
  update(
    input: TemplateWrite,
    expectedRevision: number,
    version: VersionWrite | null,
  ): Promise<TemplateView>;
  /** Sets visibility without touching the revision (but with a fresh
   * sequence number). Returns null when missing; the domain maps
   * missing to 404 and foreign owners to 403. */
  setPublished(
    id: string,
    publishedAt: Date | null,
  ): Promise<TemplateView | null>;
  /** Deletes the row (versions and saves cascade) and writes the
   * tombstone with a fresh sequence number, atomically. Returns the
   * owner id, or null when missing. */
  deleteWithTombstone(id: string): Promise<{ ownerId: string } | null>;
  listByOwner(
    ownerId: string,
    query: PageQuery,
  ): Promise<Page<TemplateSummaryView>>;
  listPublished(query: PublishedQuery): Promise<Page<TemplateSummaryView>>;
  /** Adds to use_count for a published template only. False means
   * missing or private — the domain answers 404 either way. */
  incrementUseCount(id: string, by: number): Promise<boolean>;
  /** UTC-day counter behind the per-user use cap. Returns the day's new
   * total for this user and template. */
  addDailyUse(
    userId: string,
    templateId: string,
    day: Date,
    by: number,
  ): Promise<number>;
  /** Reads the UTC-day counter without writing. */
  getDailyUse(userId: string, templateId: string, day: Date): Promise<number>;
  listVersions(
    templateId: string,
    query: PageQuery,
  ): Promise<Page<VersionSummaryView>>;
  findVersion(
    templateId: string,
    versionNo: number,
  ): Promise<VersionView | null>;
  /** Deletes one version. "missing" when the row is absent, "newest"
   * when it is the head (the head is never deleted) — the domain maps
   * those to 404 and 400. Deleting history changes no content, so no
   * revision, sequence or timestamp moves. */
  deleteVersion(
    templateId: string,
    versionNo: number,
  ): Promise<"deleted" | "missing" | "newest">;
}

export interface SavedRepository {
  list(userId: string, query: PageQuery): Promise<Page<TemplateSummaryView>>;
  countByUser(userId: string): Promise<number>;
  /** Idempotent: saving twice is one row. The caller checks the
   * template is published and the user is under quota first. */
  save(userId: string, templateId: string): Promise<void>;
  /** Idempotent: nothing saved is still a success. */
  unsave(userId: string, templateId: string): Promise<void>;
  /** Saved rows with their templates (null when the template was
   * deleted) and the tombstone time for deleted rows. */
  listManifest(userId: string): Promise<ManifestSource[]>;
}

/** One saved-list row with its template (null when deleted) and, for
 * deleted rows, the tombstone time the manifest reports as updated_at. */
export interface ManifestSource {
  templateId: string;
  addedAt: Date;
  template: TemplateView | null;
  deletedAt: Date | null;
}
