import { useEffect, useState } from "react";
import { compileTemplateCss } from "@/lib/templates/compileTemplateCss";

/**
 * Compiled Tailwind CSS for `html`, for live previews.
 *
 * Returns "" until the first compile finishes (callers then render with the
 * shared bundle) and keeps the previous stylesheet while a new one compiles,
 * so typing never flashes unstyled content.
 */
export function useCompiledCss(html: string): string {
  const [css, setCss] = useState("");
  useEffect(() => {
    let cancelled = false;
    compileTemplateCss(html).then((r) => {
      if (!cancelled && r.key) setCss(r.css);
    });
    return () => {
      cancelled = true;
    };
  }, [html]);
  return css;
}
