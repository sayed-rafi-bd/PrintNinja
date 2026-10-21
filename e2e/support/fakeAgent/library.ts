// In-memory library cache for the fake agent (Phase 4): datasets,
// profiles, fonts and the account-settings dirty flags. Mirrors the
// Rust commands field for field: dirty writes, tombstones, synced takes
// server state, unknown printers/templates leave rows dormant. The
// account allow-list matches the server (ui_density, brand_name,
// brand_logo); device keys are never dirty.

import { getSetting, setSetting } from "./store.js";
import type { ApplyReport } from "./cache.js";

export const ACCOUNT_SETTING_KEYS = ["ui_density", "brand_name", "brand_logo"];

export interface FakeDatasetRow {
  id: number;
  server_id: string;
  name: string;
  data_json: string;
  server_revision: number | null;
  base_revision: number | null;
  sync_state: "synced" | "dirty" | "deleted_pending" | "conflict";
  updated_at: string;
}

export interface FakeProfileRow {
  id: number;
  server_id: string;
  template_server_id: string;
  printer_name: string;
  settings_json: string;
  server_revision: number | null;
  base_revision: number | null;
  sync_state: "synced" | "dirty" | "deleted_pending" | "conflict";
  updated_at: string;
}

export interface FakeFontRow {
  id: number;
  server_id: string;
  family: string;
  format: string;
  sha256: string;
  size_bytes: number;
  server_revision: number | null;
  base_revision: number | null;
  sync_state: "synced" | "dirty" | "deleted_pending" | "conflict";
  updated_at: string;
  bytes: number[] | null;
}

export interface FakePrinterRow {
  id: number;
  name: string;
}

const DATASETS_KEY = "fake-agent:datasets";
const PROFILES_KEY = "fake-agent:profiles";
const FONTS_KEY = "fake-agent:fonts";
const PRINTERS_KEY = "fake-agent:printers";
const DIRTY_SETTINGS_KEY = "fake-agent:dirty-settings";

function readRows<T>(key: string): T[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const rows = JSON.parse(raw) as T[];
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", bytes as unknown as BufferSource)
    .then((digest) =>
      [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
}

export function createFakeLibrary(deps: {
  templates: Map<number, { id: number; server_id: string | null }>;
}) {
  let nextDatasetId = 1;
  let nextProfileId = 1;
  let nextFontId = 1;
  let nextPrinterId = 1;
  const datasets = new Map<number, FakeDatasetRow>();
  const profiles = new Map<number, FakeProfileRow>();
  const fonts = new Map<number, FakeFontRow>();
  const printers = new Map<number, FakePrinterRow>();
  const dirtySettings = new Map<string, "dirty" | "deleted_pending">();

  function persistAll(): void {
    try {
      localStorage.setItem(
        DATASETS_KEY,
        JSON.stringify([...datasets.values()]),
      );
      localStorage.setItem(
        PROFILES_KEY,
        JSON.stringify([...profiles.values()]),
      );
      // Font bytes ride base64; F-suite files are tiny, and a
      // quota error just keeps them in memory for the session.
      localStorage.setItem(
        FONTS_KEY,
        JSON.stringify(
          [...fonts.values()].map((r) => ({
            ...r,
            bytes: r.bytes ? btoa(String.fromCharCode(...r.bytes)) : null,
          })),
        ),
      );
      localStorage.setItem(
        PRINTERS_KEY,
        JSON.stringify([...printers.values()]),
      );
      localStorage.setItem(
        DIRTY_SETTINGS_KEY,
        JSON.stringify([...dirtySettings]),
      );
    } catch {
      // Storage full: the cache keeps serving memory.
    }
  }

  // Reload persistence first (a reload restarts the app); printers also
  // seed from the one-shot seed so specs can name them up front.
  const persistedDatasets = readRows<FakeDatasetRow>(DATASETS_KEY);
  if (persistedDatasets) {
    for (const row of persistedDatasets) {
      datasets.set(row.id, row);
      nextDatasetId = Math.max(nextDatasetId, row.id + 1);
    }
  }
  const persistedProfiles = readRows<FakeProfileRow>(PROFILES_KEY);
  if (persistedProfiles) {
    for (const row of persistedProfiles) {
      profiles.set(row.id, row);
      nextProfileId = Math.max(nextProfileId, row.id + 1);
    }
  }
  const persistedFonts = readRows<
    Omit<FakeFontRow, "bytes"> & { bytes: string | null }
  >(FONTS_KEY);
  if (persistedFonts) {
    for (const row of persistedFonts) {
      let bytes: number[] | null = null;
      if (row.bytes) {
        try {
          bytes = [...atob(row.bytes)].map((c) => c.charCodeAt(0));
        } catch {
          bytes = null;
        }
      }
      fonts.set(row.id, { ...row, bytes });
      nextFontId = Math.max(nextFontId, row.id + 1);
    }
  }
  const persistedPrinters = readRows<FakePrinterRow>(PRINTERS_KEY);
  if (persistedPrinters) {
    for (const row of persistedPrinters) {
      printers.set(row.id, row);
      nextPrinterId = Math.max(nextPrinterId, row.id + 1);
    }
  } else {
    try {
      const seed = JSON.parse(
        localStorage.getItem("fake-agent:seed") ?? "{}",
      ) as {
        printers?: Array<{ name?: string }>;
      };
      for (const p of seed.printers ?? []) {
        const id = nextPrinterId++;
        printers.set(id, { id, name: String(p.name ?? `E2E Printer ${id}`) });
      }
      if (printers.size > 0) persistAll();
    } catch {
      // No seed printers.
    }
  }
  const persistedDirty =
    readRows<[string, "dirty" | "deleted_pending"]>(DIRTY_SETTINGS_KEY);
  if (persistedDirty) {
    for (const [key, state] of persistedDirty) dirtySettings.set(key, state);
  }

  const findDataset = (id: number): FakeDatasetRow => {
    const row = datasets.get(id);
    if (!row || row.sync_state === "deleted_pending")
      throw new Error(`Dataset ${id} not found`);
    return row;
  };
  const findDatasetByServer = (
    serverId: string,
  ): FakeDatasetRow | undefined => {
    for (const row of datasets.values())
      if (row.server_id === serverId) return row;
    return undefined;
  };
  const findProfileByServer = (
    serverId: string,
  ): FakeProfileRow | undefined => {
    for (const row of profiles.values())
      if (row.server_id === serverId) return row;
    return undefined;
  };
  const findFontByServer = (serverId: string): FakeFontRow | undefined => {
    for (const row of fonts.values())
      if (row.server_id === serverId) return row;
    return undefined;
  };
  const printerName = (id: number): string => {
    const row = printers.get(id);
    if (!row) throw new Error(`Printer ${id} not found`);
    return row.name.toLowerCase();
  };
  const templateServerId = (id: number): string => {
    const row = deps.templates.get(id);
    if (!row?.server_id) throw new Error(`Template ${id} is not synced yet`);
    return row.server_id;
  };

  return {
    /** Test seam: the raw stores plus id allocators. */
    _store: {
      datasets,
      profiles,
      fonts,
      printers,
      dirtySettings,
      nextDatasetId: () => nextDatasetId++,
      nextProfileId: () => nextProfileId++,
      nextFontId: () => nextFontId++,
      nextPrinterId: () => nextPrinterId++,
    },

    // ── printers (device-local) ──
    listPrinters(): FakePrinterRow[] {
      return [...printers.values()];
    },
    addPrinter(name: string): FakePrinterRow {
      const id = nextPrinterId++;
      const row = { id, name };
      printers.set(id, row);
      persistAll();
      return row;
    },
    deletePrinter(id: number): void {
      // No foreign keys: profiles keyed at this printer stay dormant.
      printers.delete(id);
      persistAll();
    },

    // ── datasets ──
    listDatasets(): FakeDatasetRow[] {
      return [...datasets.values()]
        .filter((r) => r.sync_state !== "deleted_pending")
        .sort((a, b) => (a.name < b.name ? -1 : 1));
    },
    saveDataset(req: {
      id?: number | null;
      name: string;
      data_json: string;
    }): FakeDatasetRow {
      const name = req.name.trim();
      if (!name) throw new Error("Dataset name required");
      JSON.parse(req.data_json);
      if (req.id != null) {
        const row = findDataset(req.id);
        row.name = name;
        row.data_json = req.data_json;
        row.sync_state = "dirty";
        row.updated_at = new Date().toISOString();
        persistAll();
        return row;
      }
      const row: FakeDatasetRow = {
        id: nextDatasetId++,
        server_id: crypto.randomUUID(),
        name,
        data_json: req.data_json,
        server_revision: null,
        base_revision: null,
        sync_state: "dirty",
        updated_at: new Date().toISOString(),
      };
      datasets.set(row.id, row);
      persistAll();
      return row;
    },
    deleteDataset(id: number): void {
      const row = findDataset(id);
      row.sync_state = "deleted_pending";
      persistAll();
    },
    listDirtyDatasets(): Array<{
      server_id: string;
      name: string;
      data_json: string;
      base_revision: number | null;
    }> {
      return [...datasets.values()]
        .filter((r) => r.sync_state === "dirty")
        .map((r) => ({
          server_id: r.server_id,
          name: r.name,
          data_json: r.data_json,
          base_revision: r.base_revision,
        }));
    },
    markDatasetPushed(serverId: string, revision: number): void {
      const row = findDatasetByServer(serverId);
      if (!row) throw new Error(`no cached dataset with server id ${serverId}`);
      row.sync_state = "synced";
      row.server_revision = revision;
      row.base_revision = revision;
      persistAll();
    },
    listTombstonedDatasets(): string[] {
      return [...datasets.values()]
        .filter((r) => r.sync_state === "deleted_pending")
        .map((r) => r.server_id);
    },
    listSyncedDatasets(): string[] {
      return [...datasets.values()]
        .filter((r) => r.sync_state === "synced")
        .map((r) => r.server_id);
    },
    forgetDataset(serverId: string): boolean {
      const row = findDatasetByServer(serverId);
      if (!row) return false;
      datasets.delete(row.id);
      persistAll();
      return true;
    },

    // ── profiles ──
    listProfiles(filter: {
      printer_id?: number | null;
      template_id?: number | null;
    }): Array<
      FakeProfileRow & { printer_id: number | null; template_id: number | null }
    > {
      let wantedPrinter: string | null = null;
      let wantedTemplate: string | null = null;
      if (filter.printer_id != null) {
        const row = printers.get(filter.printer_id);
        if (!row) return [];
        wantedPrinter = row.name.toLowerCase();
      }
      if (filter.template_id != null) {
        const row = deps.templates.get(filter.template_id);
        if (!row?.server_id) return [];
        wantedTemplate = row.server_id;
      }
      return [...profiles.values()]
        .filter((r) => r.sync_state !== "deleted_pending")
        .filter(
          (r) =>
            (wantedPrinter === null || r.printer_name === wantedPrinter) &&
            (wantedTemplate === null ||
              r.template_server_id === wantedTemplate),
        )
        .map((r) => ({
          ...r,
          printer_id:
            [...printers.values()].find(
              (p) => p.name.toLowerCase() === r.printer_name,
            )?.id ?? null,
          template_id:
            [...deps.templates.values()].find(
              (t) => t.server_id === r.template_server_id,
            )?.id ?? null,
        }))
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    },
    saveProfile(req: {
      printer_id: number;
      template_id: number;
      settings_json: string;
    }): FakeProfileRow {
      JSON.parse(req.settings_json);
      const printer_name = printerName(req.printer_id);
      const template_server_id = templateServerId(req.template_id);
      const existing = [...profiles.values()].find(
        (r) =>
          r.template_server_id === template_server_id &&
          r.printer_name === printer_name,
      );
      if (existing && existing.sync_state !== "deleted_pending") {
        existing.settings_json = req.settings_json;
        existing.sync_state = "dirty";
        existing.updated_at = new Date().toISOString();
        persistAll();
        return existing;
      }
      const row: FakeProfileRow = {
        id: nextProfileId++,
        server_id: existing?.server_id ?? crypto.randomUUID(),
        template_server_id,
        printer_name,
        settings_json: req.settings_json,
        server_revision: existing?.server_revision ?? null,
        base_revision: existing?.base_revision ?? null,
        sync_state: "dirty",
        updated_at: new Date().toISOString(),
      };
      if (existing) profiles.delete(existing.id);
      profiles.set(row.id, row);
      persistAll();
      return row;
    },
    deleteProfile(id: number): void {
      const row = profiles.get(id);
      if (!row || row.sync_state === "deleted_pending")
        throw new Error(`Profile ${id} not found`);
      row.sync_state = "deleted_pending";
      persistAll();
    },
    listDirtyProfiles() {
      return [...profiles.values()]
        .filter((r) => r.sync_state === "dirty")
        .map((r) => ({
          server_id: r.server_id,
          template_id: r.template_server_id,
          printer_name: r.printer_name,
          settings_json: r.settings_json,
          base_revision: r.base_revision,
        }));
    },
    markProfilePushed(serverId: string, revision: number): void {
      const row = findProfileByServer(serverId);
      if (!row) throw new Error(`no cached profile with server id ${serverId}`);
      row.sync_state = "synced";
      row.server_revision = revision;
      row.base_revision = revision;
      persistAll();
    },
    listTombstonedProfiles(): string[] {
      return [...profiles.values()]
        .filter((r) => r.sync_state === "deleted_pending")
        .map((r) => r.server_id);
    },
    listSyncedProfiles(): string[] {
      return [...profiles.values()]
        .filter((r) => r.sync_state === "synced")
        .map((r) => r.server_id);
    },
    forgetProfile(serverId: string): boolean {
      const row = findProfileByServer(serverId);
      if (!row) return false;
      profiles.delete(row.id);
      persistAll();
      return true;
    },

    // ── fonts ──
    listFonts(): Array<FakeFontRow & { state: string }> {
      return [...fonts.values()]
        .filter((r) => r.sync_state !== "deleted_pending")
        .sort((a, b) => (a.family < b.family ? -1 : 1))
        .map((r) => ({
          ...r,
          state: getSetting(`font-state-${r.server_id}`) ?? "pending",
        }));
    },
    async uploadFont(req: {
      file_name: string;
      file_data: number[];
      family?: string | null;
    }): Promise<FakeFontRow> {
      const base = String(req.file_name).split(/[/\\]/).pop() ?? "";
      const ext = (base.split(".").pop() ?? "").toLowerCase();
      if (!["ttf", "otf", "woff", "woff2"].includes(ext)) {
        throw new Error(`Unsupported font format '${ext}'`);
      }
      if (req.file_data.length < 4) throw new Error("Font file is empty");
      // Mirror Rust: refuse the wrong content at upload (magic bytes),
      // so the engine never pushes a renamed non-font.
      const magic: Record<string, number[]> = {
        ttf: [0x00, 0x01, 0x00, 0x00],
        otf: [0x4f, 0x54, 0x54, 0x4f],
        woff: [0x77, 0x4f, 0x46, 0x46],
        woff2: [0x77, 0x4f, 0x46, 0x32],
      };
      const want = magic[ext] ?? [];
      if (!want.every((b, i) => req.file_data[i] === b)) {
        throw new Error(
          `Font file is not ${ext} content (magic bytes mismatch)`,
        );
      }
      const family =
        req.family?.trim() || base.replace(new RegExp(`\\.${ext}$`), "");
      const sha = await sha256Hex(new Uint8Array(req.file_data));
      const row: FakeFontRow = {
        id: nextFontId++,
        server_id: crypto.randomUUID(),
        family,
        format: ext,
        sha256: sha,
        size_bytes: req.file_data.length,
        server_revision: null,
        base_revision: null,
        sync_state: "dirty",
        updated_at: new Date().toISOString(),
        bytes: req.file_data,
      };
      fonts.set(row.id, row);
      setSetting(`font-state-${row.server_id}`, "ready");
      persistAll();
      return row;
    },
    deleteFont(id: number): void {
      const row = fonts.get(id);
      if (!row || row.sync_state === "deleted_pending")
        throw new Error(`Font ${id} not found`);
      row.sync_state = "deleted_pending";
      persistAll();
    },
    listDirtyFonts() {
      return [...fonts.values()]
        .filter((r) => r.sync_state === "dirty")
        .map((r) => ({
          server_id: r.server_id,
          name: r.family,
          base_revision: r.base_revision,
        }));
    },
    markFontPushed(serverId: string, revision: number): void {
      const row = findFontByServer(serverId);
      if (!row) throw new Error(`no cached font with server id ${serverId}`);
      row.sync_state = "synced";
      row.server_revision = revision;
      row.base_revision = revision;
      persistAll();
    },
    listTombstonedFonts(): string[] {
      return [...fonts.values()]
        .filter((r) => r.sync_state === "deleted_pending")
        .map((r) => r.server_id);
    },
    listSyncedFonts(): string[] {
      return [...fonts.values()]
        .filter((r) => r.sync_state === "synced")
        .map((r) => r.server_id);
    },
    forgetFont(serverId: string): boolean {
      const row = findFontByServer(serverId);
      if (!row) return false;
      fonts.delete(row.id);
      persistAll();
      return true;
    },
    readFontFile(serverId: string): number[] {
      const row = findFontByServer(serverId);
      if (!row?.bytes) throw new Error(`Font ${serverId} not found`);
      return row.bytes;
    },
    async downloadPendingFonts(): Promise<{
      downloaded: number;
      failed: number;
    }> {
      const url = getSetting("share_service_url");
      const token = getSetting("share_session_token");
      if (!url?.trim() || !token?.trim()) return { downloaded: 0, failed: 0 };
      let downloaded = 0;
      let failed = 0;
      for (const row of fonts.values()) {
        if (row.sync_state !== "synced" || !row.sha256) continue;
        if (
          (getSetting(`font-state-${row.server_id}`) ?? "pending") ===
            "ready" &&
          row.bytes
        )
          continue;
        try {
          const res = await fetch(
            `${url.replace(/\/$/, "")}/v2/fonts/${row.server_id}/file`,
            {
              headers: { Authorization: `Bearer ${token}` },
            },
          );
          if (!res.ok) throw new Error(`download failed: ${res.status}`);
          const bytes = new Uint8Array(await res.arrayBuffer());
          const actual = await sha256Hex(bytes);
          if (actual !== row.sha256) throw new Error("SHA-256 mismatch");
          row.bytes = [...bytes];
          row.size_bytes = bytes.length;
          setSetting(`font-state-${row.server_id}`, "ready");
          downloaded += 1;
        } catch {
          setSetting(`font-state-${row.server_id}`, "error");
          failed += 1;
        }
      }
      persistAll();
      return { downloaded, failed };
    },

    // ── account settings ──
    markSettingDirty(key: string, value: string): void {
      if (!ACCOUNT_SETTING_KEYS.includes(key)) return;
      dirtySettings.set(key, value === "" ? "deleted_pending" : "dirty");
      persistAll();
    },
    listDirtySettings(): Array<{
      key: string;
      value: string;
      tombstone: boolean;
    }> {
      const out: Array<{ key: string; value: string; tombstone: boolean }> = [];
      for (const [key, state] of dirtySettings) {
        if (!ACCOUNT_SETTING_KEYS.includes(key)) continue;
        out.push({
          key,
          value: getSetting(key) ?? "",
          tombstone: state === "deleted_pending",
        });
      }
      return out.sort((a, b) => (a.key < b.key ? -1 : 1));
    },
    markSettingPushed(key: string): void {
      if (!dirtySettings.has(key))
        throw new Error(`Setting '${key}' not found`);
      dirtySettings.delete(key);
      persistAll();
    },
    listTombstonedSettings(): string[] {
      return [...dirtySettings]
        .filter(([, s]) => s === "deleted_pending")
        .map(([k]) => k);
    },
    listSyncedSettings(): string[] {
      // Synced = allow-listed keys with a value that are not dirty.
      return ACCOUNT_SETTING_KEYS.filter(
        (k) => !dirtySettings.has(k) && getSetting(k) != null,
      );
    },
    forgetSetting(key: string): boolean {
      setSetting(key, null);
      dirtySettings.delete(key);
      persistAll();
      return true;
    },

    // ── sync application ──
    applyLibraryUpsert(
      entity: string,
      data: Record<string, unknown>,
      report: ApplyReport,
    ): void {
      if (entity === "dataset") {
        const serverId = String(data["id"]);
        const existing = findDatasetByServer(serverId);
        if (existing && existing.sync_state !== "synced") {
          report.skipped_dirty += 1;
          return;
        }
        if (existing) {
          existing.name = String(data["name"] ?? existing.name);
          existing.data_json = String(data["data_json"] ?? existing.data_json);
          existing.server_revision = Number(
            data["revision"] ?? existing.server_revision,
          );
          existing.base_revision = existing.server_revision;
          existing.sync_state = "synced";
        } else {
          const row: FakeDatasetRow = {
            id: nextDatasetId++,
            server_id: serverId,
            name: String(data["name"] ?? ""),
            data_json: String(data["data_json"] ?? "{}"),
            server_revision: Number(data["revision"] ?? 1),
            base_revision: Number(data["revision"] ?? 1),
            sync_state: "synced",
            updated_at: new Date().toISOString(),
          };
          datasets.set(row.id, row);
        }
        report.applied_upserts += 1;
        persistAll();
        return;
      }
      if (entity === "profile") {
        const serverId = String(data["id"]);
        const existing = findProfileByServer(serverId);
        if (existing && existing.sync_state !== "synced") {
          report.skipped_dirty += 1;
          return;
        }
        if (existing) {
          existing.template_server_id = String(
            data["template_id"] ?? existing.template_server_id,
          );
          existing.printer_name = String(
            data["printer_name"] ?? existing.printer_name,
          );
          existing.settings_json = String(
            data["settings_json"] ?? existing.settings_json,
          );
          existing.server_revision = Number(
            data["revision"] ?? existing.server_revision,
          );
          existing.base_revision = existing.server_revision;
          existing.sync_state = "synced";
        } else {
          const row: FakeProfileRow = {
            id: nextProfileId++,
            server_id: serverId,
            template_server_id: String(data["template_id"] ?? ""),
            printer_name: String(data["printer_name"] ?? ""),
            settings_json: String(data["settings_json"] ?? "{}"),
            server_revision: Number(data["revision"] ?? 1),
            base_revision: Number(data["revision"] ?? 1),
            sync_state: "synced",
            updated_at: new Date().toISOString(),
          };
          profiles.set(row.id, row);
        }
        report.applied_upserts += 1;
        persistAll();
        return;
      }
      if (entity === "setting") {
        const key = String(data["key"]);
        if (dirtySettings.has(key)) {
          report.skipped_dirty += 1;
          return;
        }
        setSetting(key, String(data["value"] ?? ""));
        report.applied_upserts += 1;
        persistAll();
        return;
      }
      if (entity === "font") {
        const serverId = String(data["id"]);
        const existing = findFontByServer(serverId);
        if (existing && existing.sync_state !== "synced") {
          report.skipped_dirty += 1;
          return;
        }
        const sha = String(data["sha256"] ?? "");
        if (existing) {
          existing.family = String(data["name"] ?? existing.family);
          existing.format = String(data["format"] ?? existing.format);
          existing.size_bytes = Number(
            data["size_bytes"] ?? existing.size_bytes,
          );
          existing.server_revision = Number(
            data["revision"] ?? existing.server_revision,
          );
          existing.base_revision = existing.server_revision;
          existing.sync_state = "synced";
          if (existing.sha256 !== sha) {
            existing.sha256 = sha;
            existing.bytes = null;
            setSetting(`font-state-${serverId}`, "pending");
          }
        } else {
          const row: FakeFontRow = {
            id: nextFontId++,
            server_id: serverId,
            family: String(data["name"] ?? ""),
            format: String(data["format"] ?? ""),
            sha256: sha,
            size_bytes: Number(data["size_bytes"] ?? 0),
            server_revision: Number(data["revision"] ?? 1),
            base_revision: Number(data["revision"] ?? 1),
            sync_state: "synced",
            updated_at: new Date().toISOString(),
            bytes: null,
          };
          fonts.set(row.id, row);
          setSetting(`font-state-${serverId}`, "pending");
        }
        report.applied_upserts += 1;
        persistAll();
        return;
      }
      throw new Error(`unsupported sync entity '${entity}'`);
    },
    applyLibraryDelete(
      entity: string,
      serverId: string,
      report: ApplyReport,
    ): void {
      if (entity === "dataset") {
        const existing = findDatasetByServer(serverId);
        if (!existing) return;
        if (existing.sync_state !== "synced") {
          report.skipped_dirty += 1;
          return;
        }
        datasets.delete(existing.id);
        report.applied_deletes += 1;
        persistAll();
        return;
      }
      if (entity === "profile") {
        const existing = findProfileByServer(serverId);
        if (!existing) return;
        if (existing.sync_state !== "synced") {
          report.skipped_dirty += 1;
          return;
        }
        profiles.delete(existing.id);
        report.applied_deletes += 1;
        persistAll();
        return;
      }
      if (entity === "setting") {
        if (dirtySettings.has(serverId)) {
          report.skipped_dirty += 1;
          return;
        }
        if (getSetting(serverId) == null) return;
        setSetting(serverId, null);
        report.applied_deletes += 1;
        persistAll();
        return;
      }
      if (entity === "font") {
        const existing = findFontByServer(serverId);
        if (!existing) return;
        if (existing.sync_state !== "synced") {
          report.skipped_dirty += 1;
          return;
        }
        fonts.delete(existing.id);
        report.applied_deletes += 1;
        persistAll();
        return;
      }
      throw new Error(`unsupported sync entity '${entity}'`);
    },

    clearLibrary(): void {
      datasets.clear();
      profiles.clear();
      fonts.clear();
      dirtySettings.clear();
      persistAll();
    },
  };
}

export type FakeLibrary = ReturnType<typeof createFakeLibrary>;
