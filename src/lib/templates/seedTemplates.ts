import { compiledFields } from "@/lib/templates/compileTemplateCss";
import { agent } from "@/lib/agent/commands";
import { STARTER_TEMPLATES } from "@/lib/templates/defaultTemplate";

export interface StarterTemplate {
  id: number;
  name: string;
  page_w_mm: number;
  page_h_mm: number;
  orientation: string;
  html: string;
  css: string;
  compiled_css: string;
  compiled_key: string;
}

/**
 * Return the templates, seeding the bundled starter on first run.
 *
 * Always reads fresh from `list_templates` — no module memo, so a height
 * saved in Designer is visible in Print without a reload. Seed failures
 * fall back to whatever was created.
 */

const toStarter = (row: {
  id: number;
  name: string;
  page_w_mm: number;
  page_h_mm: number;
  orientation: string;
  html?: string;
  css?: string;
  compiled_css?: string;
  compiled_key?: string;
}): StarterTemplate => ({
  id: row.id,
  name: row.name,
  page_w_mm: row.page_w_mm,
  page_h_mm: row.page_h_mm,
  orientation: row.orientation,
  html: row.html ?? "",
  css: row.css ?? "",
  compiled_css: row.compiled_css ?? "",
  compiled_key: row.compiled_key ?? "",
});

async function loadOrSeed(): Promise<StarterTemplate[]> {
  const existing = await agent("list_templates", {});
  if (existing && existing.length > 0) return existing.map(toStarter);

  const created: StarterTemplate[] = [];
  for (const t of STARTER_TEMPLATES) {
    try {
      const row = await agent("create_template", {
        req: {
          name: t.name,
          page_w_mm: t.page_w_mm,
          page_h_mm: t.page_h_mm,
          orientation: t.orientation,
          html: t.html,
          css: t.css,
          ...(await compiledFields(t.html)),
        },
      });
      created.push(toStarter(row));
    } catch (e) {
      // A duplicate name or a backend without the command must not abort the
      // rest of the seed; the caller falls back to whatever was created.
      console.warn(`Failed to seed starter template "${t.name}":`, e);
    }
  }
  return created;
}

export function ensureStarterTemplates(): Promise<StarterTemplate[]> {
  return loadOrSeed().catch((e) => {
    console.warn("Starter template seeding unavailable:", e);
    return [] as StarterTemplate[];
  });
}

/** Alias for callers that want an explicit refresh after Save/sync. */
export const refreshTemplates = ensureStarterTemplates;
