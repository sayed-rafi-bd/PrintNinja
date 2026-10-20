import { useEffect, useState } from "react";

/** Tailwind's `lg` breakpoint: the desktop workspace starts here. */
export const DESKTOP_QUERY = "(min-width: 1024px)";

/** Wide enough to show the Designer's controls column at full width; narrower desktops get the icon rail. */
export const WIDE_QUERY = "(min-width: 1440px)";

const read = (query: string) =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false;

/** Whether a CSS media query currently matches; updates when it changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => read(query));
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
