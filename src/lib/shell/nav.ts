import {
  FlaskConical,
  History,
  Library,
  PencilRuler,
  Printer,
  Send,
  Settings,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  path: string;
  icon: LucideIcon;
  labelKey: string;
  /** Second key of the "G then key" go-to shortcut. */
  shortcut: string;
}

export interface NavGroup {
  id: "work" | "build" | "admin";
  labelKey: string;
  items: NavItem[];
}

/** Groups follow the job someone is doing, not the feature list. */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: "work",
    labelKey: "nav.group_work",
    items: [
      { path: "/print", icon: Send, labelKey: "nav.print", shortcut: "p" },
      {
        path: "/history",
        icon: History,
        labelKey: "nav.history",
        shortcut: "h",
      },
    ],
  },
  {
    id: "build",
    labelKey: "nav.group_build",
    items: [
      { path: "/", icon: PencilRuler, labelKey: "nav.designer", shortcut: "d" },
      {
        path: "/templates",
        icon: Library,
        labelKey: "nav.templates",
        shortcut: "t",
      },
    ],
  },
  {
    id: "admin",
    labelKey: "nav.group_admin",
    items: [
      {
        path: "/printers",
        icon: Printer,
        labelKey: "nav.printers",
        shortcut: "r",
      },
      {
        path: "/api-explorer",
        icon: FlaskConical,
        labelKey: "nav.api_explorer",
        shortcut: "e",
      },
      {
        path: "/settings",
        icon: Settings,
        labelKey: "nav.settings",
        shortcut: "s",
      },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/**
 * The phone bottom bar has five slots: four primary pages plus a "More"
 * button. Anything not in this list lives behind the More sheet, so the bar
 * never grows past five tap targets (PLAN.md phase 1).
 */
export const MOBILE_PRIMARY_PATHS = [
  "/print",
  "/history",
  "/templates",
  "/printers",
] as const;

export const MOBILE_PRIMARY_ITEMS: NavItem[] = MOBILE_PRIMARY_PATHS.map(
  (path) => NAV_ITEMS.find((item) => item.path === path)!,
);

/** Pages behind the bottom bar's More button. */
export const MOBILE_MORE_ITEMS: NavItem[] = NAV_ITEMS.filter(
  (item) => !(MOBILE_PRIMARY_PATHS as readonly string[]).includes(item.path),
);

export function isActivePath(currentPath: string, itemPath: string): boolean {
  if (itemPath === "/")
    return currentPath === "/" || currentPath.startsWith("/template/");
  return currentPath === itemPath || currentPath.startsWith(`${itemPath}/`);
}
