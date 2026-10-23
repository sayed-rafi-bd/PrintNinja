// In-memory sync cache for the fake desktop agent
// (REFACTORING.md section 11, Phase 3). Mirrors the Rust cache commands
// field for field: apply is atomic (validate first, then mutate), dirty
// rows survive pulls and remote deletes, unknown entities and ops fail
// the whole page, versions append as created_by=sync and prune beyond
// the newest 20, and the cursor only moves on success. The shared
// cache_cases.json runs the same behaviors against both.

export type SyncStateName = "synced" | "dirty" | "deleted_pending" | "conflict";

export interface FakeVersion {
  version_no: number;
  html: string;
  css: string;
  created_by: string;
  label?: string | null;
  note?: string | null;
  compiled_css?: string;
  compiled_key?: string;
}

export interface FakeTemplateRow {
  id: number;
  server_id: string | null;
  name: string;
  summary: string;
  page_w: number;
  page_h: number;
  orientation: "portrait" | "landscape";
  readme: string;
  published_at: string | null;
  updated_at: string;
  server_revision: number | null;
  base_revision: number | null;
  sync_state: SyncStateName;
  kind: "own" | "saved";
  owner_handle: string | null;
  synced_at: string | null;
  versions: FakeVersion[];
}

// Mirrors find_remote_refs in src-tauri/src/render/handlebars.rs:
// the same needles, lowercased, and the same error shape, so the
// Designer shows the backend's rejection.
function assertNoRemoteRefs(html: string, css: string): void {
  const lowerHtml = html.toLowerCase();
  const lowerCss = css.toLowerCase();
  const issues: string[] = [];
  for (const needle of [
    'src="http',
    "src='http",
    'href="http',
    "href='http",
    'src="//',
    'href="//',
  ]) {
    if (lowerHtml.includes(needle)) {
      issues.push(
        `Remote reference in HTML: ${needle.slice(0, 20)} — use data: URIs`,
      );
    }
  }
  for (const needle of [
    'url("http',
    "url('http",
    "url(http",
    'url("//',
    "url('//",
    "url(//",
  ]) {
    if (lowerHtml.includes(needle) || lowerCss.includes(needle)) {
      issues.push(`Remote url() in CSS/HTML: ${needle} — use data: URIs`);
    }
  }
  if (
    lowerHtml.includes("@import") &&
    (lowerHtml.includes("http://") ||
      lowerHtml.includes("https://") ||
      lowerHtml.includes("//"))
  ) {
    issues.push("@import with remote URL — use data: URIs");
  }
  if (issues.length > 0) {
    throw new Error(
      `Template contains remote references (${issues.join("; ")}). Use data: URIs instead.`,
    );
  }
}

export interface FakeSyncState {
  account_handle: string | null;
  server_url: string | null;
  cursor: string;
  last_pull_at: string | null;
  last_error: string | null;
}

export interface SyncChangeIn {
  seq: number;
  entity: string;
  op: string;
  data?: Record<string, unknown>;
  id?: string;
}

export interface ApplyReport {
  applied_upserts: number;
  applied_deletes: number;
  skipped_dirty: number;
}

/** The Rust DirtyTemplate shape the engine pushes from. */
export interface DirtyRow {
  id: number;
  server_id: string | null;
  name: string;
  summary: string;
  page_w_mm: number;
  page_h_mm: number;
  readme: string;
  html: string;
  css: string;
  base_revision: number | null;
}

/** One template to pre-seed the fake cache (AgentSeed.templates). */
export interface SeedTemplate {
  name?: string;
  server_id?: string | null;
  html?: string;
  css?: string;
  sync_state?: SyncStateName;
  published_at?: string | null;
  summary?: string;
  readme?: string;
  page_w?: number;
  page_h?: number;
  /** Defaults to 1 with a server_id, null without. Null with a
   * server_id simulates a migrated row never confirmed by sync. */
  base_revision?: number | null;
  server_revision?: number | null;
}

import { clearAllSettings, seedTemplates } from "./store.js";
import { createFakeLibrary, type FakeLibrary } from "./library.js";

const PERSIST_KEY = "fake-agent:templates";

function readSeedTemplates(): SeedTemplate[] {
  try {
    return seedTemplates() as SeedTemplate[];
  } catch {
    return [];
  }
}

function readPersistedTemplates(): FakeTemplateRow[] | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const rows = JSON.parse(raw) as FakeTemplateRow[];
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

export function createFakeCache() {
  let nextId = 1;
  const templates = new Map<number, FakeTemplateRow>();
  const queued = new Map<string, { count: number; updatedAt: string }>();
  const sync: FakeSyncState = {
    account_handle: null,
    server_url: null,
    cursor: "",
    last_pull_at: null,
    last_error: null,
  };

  function persist(): void {
    try {
      localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify([...templates.values()]),
      );
    } catch {
      // Storage full or unavailable: the cache keeps serving memory.
    }
  }

  // Reload persistence first (a reload behaves like restarting the app),
  // otherwise the one-shot seed. nextId continues past restored rows.
  const persisted = readPersistedTemplates();
  if (persisted) {
    for (const row of persisted) {
      templates.set(row.id, row);
      nextId = Math.max(nextId, row.id + 1);
    }
  } else {
    for (const seed of readSeedTemplates()) {
      const id = nextId++;
      const html = seed.html ?? "<p>seed</p>";
      const css = seed.css ?? "";
      templates.set(id, {
        id,
        // Like the Rust backfill: local-only rows get fresh sync
        // identities so pushes and markPushed address the same id.
        server_id: seed.server_id ?? crypto.randomUUID(),
        name: seed.name ?? "Seeded",
        summary: seed.summary ?? "",
        page_w: seed.page_w ?? 210,
        page_h: seed.page_h ?? 297,
        orientation:
          (seed.page_w ?? 210) > (seed.page_h ?? 297)
            ? "landscape"
            : "portrait",
        readme: seed.readme ?? "",
        published_at: seed.published_at ?? null,
        updated_at: new Date().toISOString(),
        server_revision: seed.server_revision ?? (seed.server_id ? 1 : null),
        // An explicit null stays null: it marks a migrated row the
        // sync engine has never confirmed (?? would erase it).
        base_revision:
          seed.base_revision !== undefined
            ? seed.base_revision
            : seed.server_id
              ? 1
              : null,
        sync_state: seed.sync_state ?? (seed.server_id ? "synced" : "dirty"),
        kind: "own",
        owner_handle: null,
        synced_at: null,
        versions: [{ version_no: 1, html, css, created_by: "manual" }],
      });
    }
    if (templates.size > 0) {
      persist();
    }
  }

  const findByServerId = (serverId: string): FakeTemplateRow | undefined => {
    for (const row of templates.values()) {
      if (row.server_id === serverId) {
        return row;
      }
    }
    return undefined;
  };

  // The library shares the template rows for profile linkage and wipes
  // with the account; the templates map above stays the source of truth.
  const library: FakeLibrary = createFakeLibrary({ templates });

  const findRow = (id: number): FakeTemplateRow => {
    const row = templates.get(id);
    if (!row || row.sync_state === "deleted_pending") {
      throw new Error(`Template ${id} not found`);
    }
    return row;
  };

  const nowIso = () => new Date().toISOString();

  function validate(changes: SyncChangeIn[]): void {
    for (const change of changes) {
      if (change.op !== "upsert" && change.op !== "delete") {
        throw new Error(`unsupported sync op '${change.op}'`);
      }
      if (
        !["template", "dataset", "profile", "setting", "font"].includes(
          change.entity,
        )
      ) {
        throw new Error(`unsupported sync entity '${change.entity}'`);
      }
      if (
        change.op === "upsert" &&
        (change.data === undefined || change.data === null)
      ) {
        throw new Error("sync upsert without data");
      }
      if (change.op === "delete" && typeof change.id !== "string") {
        throw new Error("sync delete without id");
      }
    }
  }

  function pruneVersions(row: FakeTemplateRow): void {
    if (row.versions.length > 20) {
      row.versions = row.versions.slice(-20);
    }
  }

  function applyUpsert(
    data: Record<string, unknown>,
    report: ApplyReport,
  ): void {
    const serverId = data["id"] as string;
    const existing = findByServerId(serverId);
    // Mirror Rust: only synced rows take server state. Dirty keeps local
    // edits, conflict waits for the user, tombstone waits for confirm.
    if (existing && existing.sync_state !== "synced") {
      report.skipped_dirty += 1;
      return;
    }
    if (existing && existing.base_revision == null) {
      // First sync of a migrated row: matching content adopts the
      // revision with no new version; differing content conflicts
      // instead of overwriting.
      const head = existing.versions[existing.versions.length - 1];
      if (
        (head?.html ?? "") === String(data["body"] ?? "") &&
        (head?.css ?? "") === String(data["css"] ?? "")
      ) {
        existing.server_revision = Number(
          data["revision"] ?? existing.server_revision,
        );
        existing.base_revision = existing.server_revision;
        existing.synced_at = nowIso();
        report.applied_upserts += 1;
        return;
      }
      existing.sync_state = "conflict";
      report.skipped_dirty += 1;
      return;
    }
    const pageW = Math.round(Number(data["page_w_mm"] ?? 0));
    const pageH = Math.round(Number(data["page_h_mm"] ?? 0));
    const orientation = pageW > pageH ? "landscape" : "portrait";
    const html = String(data["body"] ?? "");
    const css = String(data["css"] ?? "");
    if (!existing) {
      const row: FakeTemplateRow = {
        id: nextId++,
        server_id: serverId,
        name: String(data["name"] ?? ""),
        summary: String(data["summary"] ?? ""),
        page_w: pageW,
        page_h: pageH,
        orientation,
        readme: String(data["readme"] ?? ""),
        published_at: (data["published_at"] as string | null) ?? null,
        updated_at: String(data["updated_at"] ?? nowIso()),
        server_revision: Number(data["revision"] ?? 1),
        base_revision: Number(data["revision"] ?? 1),
        sync_state: "synced",
        kind: "own",
        owner_handle: null,
        synced_at: nowIso(),
        versions: [{ version_no: 1, html, css, created_by: "sync" }],
      };
      templates.set(row.id, row);
      report.applied_upserts += 1;
      return;
    }
    existing.name = String(data["name"] ?? existing.name);
    existing.summary =
      typeof data["summary"] === "string" ? data["summary"] : existing.summary;
    existing.page_w = pageW;
    existing.page_h = pageH;
    existing.orientation = orientation;
    existing.readme =
      typeof data["readme"] === "string" ? data["readme"] : existing.readme;
    existing.published_at = (data["published_at"] as string | null) ?? null;
    existing.updated_at = String(data["updated_at"] ?? nowIso());
    existing.server_revision = Number(
      data["revision"] ?? existing.server_revision,
    );
    existing.base_revision = existing.server_revision;
    existing.sync_state = "synced";
    existing.synced_at = nowIso();
    const maxNo = existing.versions.reduce(
      (m, v) => Math.max(m, v.version_no),
      0,
    );
    existing.versions.push({
      version_no: maxNo + 1,
      html,
      css,
      created_by: "sync",
    });
    pruneVersions(existing);
    report.applied_upserts += 1;
  }

  function applyDelete(serverId: string, report: ApplyReport): void {
    const existing = findByServerId(serverId);
    if (!existing) {
      return;
    }
    if (existing.sync_state !== "synced") {
      report.skipped_dirty += 1;
      return;
    }
    templates.delete(existing.id);
    report.applied_deletes += 1;
  }

  return {
    /** Test seam: the raw store plus an id allocator. */
    _store: { templates, sync, nextId: () => nextId++ },

    /** The library rows, for the IPC commands in commands.ts. */
    library,

    applyChanges(changes: SyncChangeIn[], newCursor: string): ApplyReport {
      validate(changes);
      const report: ApplyReport = {
        applied_upserts: 0,
        applied_deletes: 0,
        skipped_dirty: 0,
      };
      for (const change of changes) {
        if (change.entity !== "template") {
          if (change.op === "upsert") {
            library.applyLibraryUpsert(
              change.entity,
              change.data as Record<string, unknown>,
              report,
            );
          } else {
            library.applyLibraryDelete(
              change.entity,
              change.id as string,
              report,
            );
          }
          continue;
        }
        if (change.op === "upsert") {
          applyUpsert(change.data as Record<string, unknown>, report);
        } else {
          applyDelete(change.id as string, report);
        }
      }
      sync.cursor = newCursor;
      sync.last_pull_at = nowIso();
      sync.last_error = null;
      persist();
      return report;
    },

    getSyncState(): FakeSyncState {
      return { ...sync };
    },

    listDirty(): DirtyRow[] {
      // The Rust DirtyTemplate shape the engine PUTs from — not the
      // internal row (page_w/html would arrive as undefined, 400).
      return [...templates.values()]
        .filter((t) => t.sync_state === "dirty")
        .map((t) => ({
          id: t.id,
          server_id: t.server_id,
          name: t.name,
          summary: t.summary,
          page_w_mm: t.page_w,
          page_h_mm: t.page_h,
          readme: t.readme,
          html: t.versions[t.versions.length - 1]?.html ?? "",
          css: t.versions[t.versions.length - 1]?.css ?? "",
          base_revision: t.base_revision,
        }));
    },

    markPushed(serverId: string, revision: number): void {
      const row = findByServerId(serverId);
      if (!row) {
        throw new Error(`no cached template with server id ${serverId}`);
      }
      row.sync_state = "synced";
      row.server_revision = revision;
      row.base_revision = revision;
      persist();
    },

    markConflicted(serverId: string): void {
      const row = findByServerId(serverId);
      if (!row) {
        throw new Error(`no cached template with server id ${serverId}`);
      }
      row.sync_state = "conflict";
      persist();
    },

    resolveConflict(
      serverId: string,
      resolution: "theirs" | "mine",
      serverCopy?: Record<string, unknown>,
      rebaseTo?: number,
    ): void {
      const row = findByServerId(serverId);
      if (!row || row.sync_state !== "conflict") {
        throw new Error(`template ${serverId} is not conflicted`);
      }
      if (resolution === "mine") {
        row.sync_state = "dirty";
        if (rebaseTo !== undefined) {
          row.server_revision = rebaseTo;
          row.base_revision = rebaseTo;
        }
        persist();
        return;
      }
      if (!serverCopy) {
        throw new Error("resolving to theirs needs the server copy");
      }
      row.name = String(serverCopy["name"] ?? row.name);
      row.summary =
        typeof serverCopy["summary"] === "string"
          ? serverCopy["summary"]
          : row.summary;
      row.page_w = Math.round(Number(serverCopy["page_w_mm"] ?? row.page_w));
      row.page_h = Math.round(Number(serverCopy["page_h_mm"] ?? row.page_h));
      row.orientation = row.page_w > row.page_h ? "landscape" : "portrait";
      row.readme =
        typeof serverCopy["readme"] === "string"
          ? serverCopy["readme"]
          : row.readme;
      row.published_at = (serverCopy["published_at"] as string | null) ?? null;
      row.updated_at = String(serverCopy["updated_at"] ?? nowIso());
      const rev = Number(serverCopy["revision"] ?? row.server_revision ?? 1);
      row.server_revision = rev;
      row.base_revision = rev;
      const html = String(serverCopy["body"] ?? "");
      const css = String(serverCopy["css"] ?? "");
      const maxNo = row.versions.reduce((m, v) => Math.max(m, v.version_no), 0);
      row.versions.push({
        version_no: maxNo + 1,
        html,
        css,
        created_by: "sync",
      });
      pruneVersions(row);
      row.sync_state = "synced";
      persist();
    },

    listTombstoned(): string[] {
      return [...templates.values()]
        .filter((t) => t.sync_state === "deleted_pending")
        .map((t) => t.server_id as string);
    },

    listSynced(): string[] {
      return [...templates.values()]
        .filter((t) => t.sync_state === "synced")
        .map((t) => t.server_id as string);
    },

    forgetTemplate(serverId: string): boolean {
      for (const [id, t] of templates) {
        if (t.server_id === serverId) {
          templates.delete(id);
          persist();
          return true;
        }
      }
      return false;
    },

    listConflicted(): { id: number; server_id: string | null; name: string }[] {
      return [...templates.values()]
        .filter((t) => t.sync_state === "conflict")
        .sort((a, b) => a.id - b.id)
        .map((t) => ({ id: t.id, server_id: t.server_id, name: t.name }));
    },

    /** Templates for list_templates: tombstones hidden, like Rust.
     * Content lives on the row itself (no versions): html/css ride along
     * with the metadata so Print previews without a second call. */
    listTemplates(): Record<string, unknown>[] {
      return [...templates.values()]
        .filter((t) => t.sync_state !== "deleted_pending")
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((t) => ({
          id: t.id,
          name: t.name,
          page_w_mm: t.page_w,
          page_h_mm: t.page_h,
          orientation: t.orientation,
          html: t.versions[t.versions.length - 1]?.html ?? "",
          css: t.versions[t.versions.length - 1]?.css ?? "",
          compiled_css: "",
          compiled_key: "",
          readme: t.readme,
          summary: t.summary,
          remote_id: t.server_id,
          server_id: t.server_id,
          published_at: t.published_at,
          origin: t.kind === "saved" ? "saved" : "own",
          origin_owner: t.owner_handle,
          withdrawn: false,
          base_revision: t.base_revision,
          sync_state: t.sync_state,
          created_at: t.updated_at,
          updated_at: t.updated_at,
        }));
    },

    getTemplate(id: number): Record<string, unknown> {
      const row = findRow(id);
      // The Rust Template shape (page_w_mm, remote_id, origin…).
      return {
        id: row.id,
        name: row.name,
        page_w_mm: row.page_w,
        page_h_mm: row.page_h,
        orientation: row.orientation,
        html: row.versions[row.versions.length - 1]?.html ?? "",
        css: row.versions[row.versions.length - 1]?.css ?? "",
        compiled_css: "",
        compiled_key: "",
        readme: row.readme,
        summary: row.summary,
        remote_id: row.server_id,
        server_id: row.server_id,
        published_at: row.published_at,
        origin: row.kind === "saved" ? "saved" : "own",
        origin_owner: row.owner_handle,
        withdrawn: false,
        base_revision: row.base_revision,
        sync_state: row.sync_state,
        created_at: row.updated_at,
        updated_at: row.updated_at,
      };
    },

    createTemplate(req: Record<string, unknown>): FakeTemplateRow {
      const name = String(req["name"] ?? "").trim();
      if (!name) {
        throw new Error("Template name required");
      }
      for (const t of templates.values()) {
        if (
          t.sync_state !== "deleted_pending" &&
          t.name.toLowerCase() === name.toLowerCase()
        ) {
          throw new Error(`A template named '${name}' already exists`);
        }
      }
      const id = nextId++;
      const html = String(req["html"] ?? "");
      const css = String(req["css"] ?? "");
      const pageW = Number(req["page_w_mm"] ?? 210);
      const pageH = Number(req["page_h_mm"] ?? 297);
      const row: FakeTemplateRow = {
        id,
        // Rust mints a fresh server id for brand-new local rows.
        server_id: (req["server_id"] as string) ?? crypto.randomUUID(),
        name,
        summary: String(req["summary"] ?? ""),
        page_w: pageW,
        page_h: pageH,
        orientation: pageW > pageH ? "landscape" : "portrait",
        readme: String(req["readme"] ?? ""),
        published_at: null,
        updated_at: nowIso(),
        server_revision: (req["server_revision"] as number) ?? null,
        base_revision: (req["base_revision"] as number) ?? null,
        sync_state: (req["sync_state"] as SyncStateName) ?? "dirty",
        kind: ((req["kind"] as string) ?? "own") as "own" | "saved",
        owner_handle: (req["owner_handle"] as string) ?? null,
        synced_at: null,
        versions: [{ version_no: 1, html, css, created_by: "manual" }],
      };
      templates.set(id, row);
      persist();
      return row;
    },

    updateTemplateMeta(id: number, req: Record<string, unknown>): void {
      const row = templates.get(id);
      if (!row || row.sync_state === "deleted_pending") {
        throw new Error(`Template ${id} not found`);
      }
      const name = String(req["name"] ?? row.name).trim();
      if (!name) {
        throw new Error("Template name required");
      }
      // Content writes carry the same remote-ref bar as creates: the
      // Rust backend validates in write_template_meta, and the Designer
      // surfaces the rejection without pushing.
      const html =
        typeof req["html"] === "string"
          ? req["html"]
          : (row.versions[row.versions.length - 1]?.html ?? "");
      const css =
        typeof req["css"] === "string"
          ? req["css"]
          : (row.versions[row.versions.length - 1]?.css ?? "");
      assertNoRemoteRefs(html, css);
      row.name = name;
      row.page_w = Number(req["page_w_mm"] ?? row.page_w);
      row.page_h = Number(req["page_h_mm"] ?? row.page_h);
      row.orientation = row.page_w > row.page_h ? "landscape" : "portrait";
      if (typeof req["summary"] === "string") {
        row.summary = req["summary"];
      }
      // Content lives on the row: write it onto the latest version in
      // place (no new version — versions are gone server-side too).
      const latest = row.versions[row.versions.length - 1];
      if (latest) {
        latest.html = html;
        latest.css = css;
        if (typeof req["compiled_css"] === "string") {
          latest.compiled_css = req["compiled_css"];
        }
        if (typeof req["compiled_key"] === "string") {
          latest.compiled_key = req["compiled_key"];
        }
      }
      row.updated_at = nowIso();
      row.sync_state = "dirty";
      persist();
    },

    updateReadme(id: number, readme: string): void {
      const row = templates.get(id);
      if (!row || row.sync_state === "deleted_pending") {
        throw new Error(`Template ${id} not found`);
      }
      row.readme = readme;
      row.updated_at = nowIso();
      row.sync_state = "dirty";
      persist();
    },

    listVersions(templateId: number): Record<string, unknown>[] {
      const row = templates.get(templateId);
      if (!row) {
        throw new Error(`Template ${templateId} not found`);
      }
      return [...row.versions]
        .sort((a, b) => b.version_no - a.version_no)
        .map((v, i) => ({
          id: templateId * 1000 + v.version_no,
          template_id: templateId,
          version_no: v.version_no,
          html: v.html,
          css: v.css,
          label: v.label ?? null,
          note: v.note ?? null,
          created_at: row.updated_at,
          created_by: v.created_by,
          compiled_css: "",
          compiled_key: "",
          _current: i === 0,
        }));
    },
    listLatestVersions(templateIds: number[]): Record<string, unknown>[] {
      const out: Record<string, unknown>[] = [];
      for (const id of templateIds) {
        const latest = this.listVersions(id)[0];
        if (latest) out.push(latest);
      }
      return out;
    },

    createVersion(
      templateId: number,
      req: Record<string, unknown>,
    ): Record<string, unknown> {
      const row = templates.get(templateId);
      if (!row || row.sync_state === "deleted_pending") {
        throw new Error(`Template ${templateId} not found`);
      }
      const html = String(req["html"] ?? "");
      const css = String(req["css"] ?? "");
      assertNoRemoteRefs(html, css);
      const maxNo = row.versions.reduce((m, v) => Math.max(m, v.version_no), 0);
      const version = {
        version_no: maxNo + 1,
        html: String(req["html"] ?? ""),
        css: String(req["css"] ?? ""),
        label: (req["label"] as string | null) ?? null,
        note: (req["note"] as string | null) ?? null,
        created_by: String(req["created_by"] ?? "manual"),
        compiled_css: String(req["compiled_css"] ?? ""),
        compiled_key: String(req["compiled_key"] ?? ""),
      };
      row.versions.push(version);
      pruneVersions(row);
      row.updated_at = nowIso();
      row.sync_state = "dirty";
      persist();
      return {
        id: templateId * 1000 + version.version_no,
        template_id: templateId,
        created_at: row.updated_at,
        ...version,
      };
    },
    setVersionCompiled(
      versionId: number,
      compiledCss: string,
      compiledKey: string,
    ): Record<string, unknown> {
      for (const row of templates.values()) {
        const v = row.versions.find(
          (x) => row.id * 1000 + x.version_no === versionId,
        );
        if (v) {
          v.compiled_css = compiledCss;
          v.compiled_key = compiledKey;
          persist();
          return { id: versionId, template_id: row.id, ...v };
        }
      }
      throw new Error(`Version ${versionId} not found`);
    },

    deleteTemplate(id: number): void {
      const row = templates.get(id);
      if (!row || row.sync_state === "deleted_pending") {
        throw new Error(`Template ${id} not found`);
      }
      row.sync_state = "deleted_pending";
      persist();
    },

    updateTemplateOrigin(id: number, req: Record<string, unknown>): void {
      const row = templates.get(id);
      if (!row) {
        throw new Error(`Template ${id} not found`);
      }
      const origin = String(req["origin"] ?? "");
      if (origin !== "own" && origin !== "saved") {
        throw new Error("origin must be 'own' or 'saved'");
      }
      row.kind = origin;
      row.owner_handle = (req["origin_owner"] as string) ?? null;
      row.updated_at = nowIso();
      persist();
    },

    queueUse(serverId: string, delta: number): number {
      const total = (queued.get(serverId)?.count ?? 0) + delta;
      if (total <= 0) {
        queued.delete(serverId);
        return 0;
      }
      queued.set(serverId, { count: total, updatedAt: nowIso() });
      return total;
    },

    listQueuedUses(): { server_template_id: string; count: number }[] {
      return [...queued.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([server_template_id, v]) => ({
          server_template_id,
          count: v.count,
        }));
    },

    clearAccount(): number {
      const count = templates.size;
      templates.clear();
      for (const key of [...queued.keys()]) {
        queued.delete(key);
      }
      library.clearLibrary();
      sync.account_handle = null;
      sync.server_url = null;
      sync.cursor = "";
      sync.last_pull_at = null;
      sync.last_error = null;
      persist();
      return count;
    },

    /**
     * Full local wipe (Settings → Retention → Reset): every template and
     * version, job history is untouched by this cache (it lives in other
     * tables the fake does not implement), every dataset, profile, font
     * and printer, the sync state and every setting — including the
     * session, so the app returns to sign-in. Counts mirror the Rust
     * ResetReport; print_jobs stays 0 (no worker, no job rows).
     */
    resetDatabase(): Record<string, number> {
      let versions = 0;
      for (const row of templates.values()) {
        versions += row.versions.length;
      }
      const report = {
        templates: templates.size,
        template_versions: versions,
        print_jobs: 0,
        fonts: library._store.fonts.size,
        datasets: library._store.datasets.size,
        profiles: library._store.profiles.size,
        printers: library._store.printers.size,
        batches: 0,
      };
      templates.clear();
      for (const key of [...queued.keys()]) {
        queued.delete(key);
      }
      library.clearLibrary(true);
      sync.account_handle = null;
      sync.server_url = null;
      sync.cursor = "";
      sync.last_pull_at = null;
      sync.last_error = null;
      clearAllSettings();
      persist();
      return report;
    },
  };
}

export type FakeCache = ReturnType<typeof createFakeCache>;
