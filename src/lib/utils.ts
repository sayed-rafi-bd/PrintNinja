import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// `h-control` / `w-control` follow the density setting. Registering them lets a
// caller's `h-8` replace them instead of fighting over CSS order.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      h: [{ h: ["control"] }],
      w: [{ w: ["control"] }],
      size: [{ size: ["control"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
