import { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import {
  Printer,
  FileText,
  Settings,
  History,
  Pencil,
  ChevronRight,
  Library,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";

const navItems = [
  { path: "/", icon: Pencil, labelKey: "nav.designer" },
  { path: "/templates", icon: Library, labelKey: "nav.templates" },
  { path: "/print", icon: Printer, labelKey: "nav.print" },
  { path: "/printers", icon: FileText, labelKey: "nav.printers" },
  { path: "/history", icon: History, labelKey: "nav.history" },
  { path: "/settings", icon: Settings, labelKey: "nav.settings" },
] as const;

function isActivePath(currentPath: string, itemPath: string): boolean {
  if (itemPath === "/") return currentPath === "/" || currentPath.startsWith("/template");
  return currentPath === itemPath || currentPath.startsWith(`${itemPath}/`);
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("printninja-sidebar-collapsed") === "true"; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem("printninja-sidebar-collapsed", String(collapsed)); } catch {}
  }, [collapsed]);

  const handleNavigate = (path: string) => {
    navigate(path);
  };

  const NavList = ({ variant = "desktop" as "desktop" | "mobile" }) => (
    <nav
      className={cn(
        "flex flex-col gap-1",
        variant === "desktop" ? (collapsed ? "p-2" : "p-4") : "p-2",
      )}
    >
      {navItems.map((item) => {
        const active = isActivePath(location.pathname, item.path);
        return (
          <Button
            key={item.path}
            variant={active ? "secondary" : "ghost"}
            className={cn(
              "w-full touch-target min-h-11",
              collapsed && variant === "desktop" ? "justify-center px-2" : "justify-start gap-3",
              active && "bg-secondary font-medium",
            )}
            onClick={() => handleNavigate(item.path)}
            aria-current={active ? "page" : undefined}
            type="button"
            title={collapsed && variant === "desktop" ? String(t(item.labelKey)) : undefined}
          >
            <item.icon className="h-5 w-5 shrink-0" />
            {(!collapsed || variant !== "desktop") && t(item.labelKey)}
          </Button>
        );
      })}
    </nav>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop / Tablet Sidebar — toggleable */}
      <aside className={cn("hidden md:flex flex-col border-r bg-card shadow-sm transition-all duration-200", collapsed ? "w-16" : "w-64")}>
        <div className={cn("flex h-16 items-center border-b", collapsed ? "justify-center px-2" : "gap-2 px-6")}>
          <Printer className="h-6 w-6 text-primary shrink-0" />
          {!collapsed && <span className="text-lg font-bold truncate">PrintNinja</span>}
          <Button
            variant="ghost"
            size="icon"
            className={cn("ml-auto h-8 w-8 shrink-0", collapsed && "ml-0")}
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand" : "Collapse"}
          >
            <ChevronRight className={cn("h-4 w-4 transition-transform", !collapsed && "rotate-180")} />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <NavList variant="desktop" />
        </div>
        {!collapsed && (
          <div className="p-3 border-t text-xs text-muted-foreground">
            <p>Tip: collapse for more canvas.</p>
          </div>
        )}
      </aside>

      {/* Mobile Bottom Navigation */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-50 border-t bg-card shadow-[0_-1px_8px_rgba(0,0,0,0.06)]"
        aria-label="Primary"
      >
        <div className="flex items-stretch h-16">
          {navItems.map((item) => {
            const active = isActivePath(location.pathname, item.path);
            return (
              <button
                key={item.path}
                type="button"
                onClick={() => handleNavigate(item.path)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  // `flex-1 min-w-0` rather than a fixed `w-16`: five
                  // 64px buttons are 320px of content plus their gaps, which
                  // overflows a 320px-wide phone and clips the last item.
                  // Sharing the row also keeps every target at least 44px
                  // wide on the narrowest device we support.
                  "flex flex-1 min-w-0 flex-col items-center justify-center gap-1 h-full px-0.5 text-xs transition-colors min-h-11",
                  active ? "text-primary font-semibold" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <item.icon className="h-5 w-5 shrink-0" />
                <span className="truncate max-w-full leading-none">{t(item.labelKey)}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Mobile Header — no hamburger, bottom nav is the navigation */}
      <header className="md:hidden fixed top-0 left-0 right-0 z-50 flex h-16 items-center border-b bg-card px-4 shadow-sm">
        <div className="flex items-center gap-2">
          <Printer className="h-6 w-6 text-primary" />
          <span className="text-lg font-bold">PrintNinja</span>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto pt-16 pb-16 md:pt-0 md:pb-0">
        <div className="container mx-auto p-4 md:p-8 max-w-7xl">
          {children}
        </div>
      </main>
    </div>
  );
}
