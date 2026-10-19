import { invoke } from "@/lib/invoke";
import {
  compileTemplateCss,
  templateCssKey,
} from "@/lib/templates/compileTemplateCss";

interface VersionRow {
  id: number;
  html: string;
  compiled_css?: string;
  compiled_key?: string;
}

/**
 * Compile every saved version whose stored CSS is missing or was produced by an
 * older compiler revision or a different class set.
 *
 * Versions saved before per-template compilation have no compiled CSS, and the
 * print path has no shared bundle to fall back on, so without this they would
 * print unstyled. It is also what rolls a compiler upgrade out to existing
 * templates: bumping `COMPILER_REV` makes every stored key stale.
 *
 * Returns the number of versions written. Never throws; a version that fails to
 * compile is skipped and retried on the next launch.
 */
export async function backfillCompiledCss(): Promise<number> {
  let written = 0;
  try {
    const templates = await invoke<{ id: number }[]>("list_templates");
    for (const t of templates ?? []) {
      const versions = await invoke<VersionRow[]>("list_versions", {
        templateId: t.id,
      });
      for (const v of versions ?? []) {
        if (v.compiled_css && v.compiled_key === templateCssKey(v.html)) continue;
        const { css, key } = await compileTemplateCss(v.html);
        if (!key) continue; // compile failed; keep whatever is stored
        await invoke("set_version_compiled_css", {
          req: { id: v.id, compiled_css: css, compiled_key: key },
        });
        written++;
      }
    }
  } catch (e) {
    console.warn("Compiled CSS backfill stopped:", e);
  }
  return written;
}

let started: Promise<number> | null = null;

/** Run the backfill once per session, however many callers ask. */
export function ensureCompiledCss(): Promise<number> {
  if (!started) started = backfillCompiledCss();
  return started;
}
