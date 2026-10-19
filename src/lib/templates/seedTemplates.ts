import { invoke } from "@/lib/invoke";
import { STARTER_TEMPLATES } from "@/lib/templates/defaultTemplate";

export interface TemplateRow {
  id: number;
  name: string;
  page_w_mm: number;
  page_h_mm: number;
  orientation: string;
}

/**
 * Return the templates, seeding the bundled starter on first run.
 *
 * The starter template used to live only in the Designer's in-memory
 * fallback, so on a fresh install `list_templates` came back empty and the
 * Print tab showed "No templates — create one in Designer" even though the app
 * ships a ready-to-print layout. It is persisted here instead, so it has a
 * real row and a real version 1 to render.
 *
 * A module-level promise dedupes concurrent callers (Designer and Print both
 * call this on mount), so the starters are only created once.
 */
let pending: Promise<TemplateRow[]> | null = null;

async function loadOrSeed(): Promise<TemplateRow[]> {
  const existing = await invoke<TemplateRow[]>("list_templates");
  if (existing && existing.length > 0) return existing;

  const created: TemplateRow[] = [];
  for (const t of STARTER_TEMPLATES) {
    try {
      const row = await invoke<TemplateRow>("create_template", {
        req: {
          name: t.name,
          page_w_mm: t.page_w_mm,
          page_h_mm: t.page_h_mm,
          orientation: t.orientation,
          html: t.html,
          css: t.css,
        },
      });
      created.push(row);
    } catch (e) {
      // A duplicate name or a backend without the command must not abort the
      // rest of the seed; the caller falls back to whatever was created.
      console.warn(`Failed to seed starter template "${t.name}":`, e);
    }
  }
  return created;
}

export function ensureStarterTemplates(): Promise<TemplateRow[]> {
  if (!pending) {
    pending = loadOrSeed().catch((e) => {
      // Web mode: no Tauri backend. Reset so a later mount can retry.
      pending = null;
      console.warn("Starter template seeding unavailable:", e);
      return [] as TemplateRow[];
    });
  }
  return pending;
}
