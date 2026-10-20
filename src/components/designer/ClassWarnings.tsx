import { useMemo } from "react";
import { TriangleAlert } from "lucide-react";
import { extractClasses } from "@/lib/templates/extractClasses";

/** How many offending classes to list before collapsing the rest. */
const MAX_LISTED = 5;

/**
 * Warns about class names that are assembled from data at render time
 * (`bg-{{color}}-500`). The per-template stylesheet is compiled from literal
 * class names, so these get no styling and fail without any error; the
 * warning is the only place the author finds out.
 *
 * Renders nothing when the template is fine.
 */
export function ClassWarnings({ html }: { html: string }) {
  const { warnings } = useMemo(() => extractClasses(html), [html]);
  if (warnings.length === 0) return null;

  const listed = warnings.slice(0, MAX_LISTED);
  const more = warnings.length - listed.length;

  return (
    <div
      role="alert"
      data-testid="class-warnings"
      className="rounded-md border border-warning/40 bg-warning-soft p-3 text-xs text-warning"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 space-y-1.5">
          <p className="font-medium">
            {warnings.length === 1
              ? "1 class name is built from data and won't be styled"
              : `${warnings.length} class names are built from data and won't be styled`}
          </p>
          <ul className="space-y-0.5 font-mono">
            {listed.map((w) => (
              <li key={w.index} className="break-all">
                Line {w.line}: <code>{w.snippet}</code>
              </li>
            ))}
            {more > 0 && <li className="font-sans">…and {more} more</li>}
          </ul>
          <p>{warnings[0].message}</p>
        </div>
      </div>
    </div>
  );
}
