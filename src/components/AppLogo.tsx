import { cn } from "@/lib/utils";

/**
 * PrintNinja mark: a page with a folded corner and printed lines.
 * Pass `src` (a data URL from Settings → Branding) to show a custom logo instead.
 */
export function AppLogo({
  className,
  src,
}: {
  className?: string;
  src?: string | null;
}) {
  if (src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        className={cn("h-7 w-7 shrink-0 rounded-sm object-contain", className)}
      />
    );
  }
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      className={cn("h-7 w-7 shrink-0", className)}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="32" height="32" rx="6" fill="hsl(var(--primary))" />
      <path
        d="M9 6h10l5 5v15a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z"
        fill="#fff"
      />
      <path
        d="M19 6v4a1 1 0 0 0 1 1h4"
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth="1.5"
      />
      <path
        d="M11.5 16h9M11.5 19.5h9M11.5 23h5"
        stroke="hsl(var(--primary))"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}
