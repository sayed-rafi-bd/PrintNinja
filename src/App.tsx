import { lazy, Suspense, useState, useEffect } from "react";
import { agent } from "@/lib/agent/commands";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { AuthGate } from "./components/AuthGate";
import { Layout } from "./components/Layout";
import { Onboarding } from "./components/Onboarding";
import { DesignerPage } from "./pages/Designer";
import { PrintPage } from "./pages/Print";
import { PrinterSetupPage } from "./pages/PrinterSetup";
import { HistoryPage } from "./pages/History";
import { SettingsPage } from "./pages/Settings";
import { TemplatesPage } from "./pages/Templates";
import { diagnostics } from "./lib/diagnostics";

// Reference page for shared components. Not bundled into production builds.
const UiKitPage = import.meta.env.DEV ? lazy(() => import("./pages/UiKit")) : null;

/** Nothing renders until there is a session the server accepts. */
export default function App() {
  return (
    <AuthGate>
      <AppContent />
    </AuthGate>
  );
}

/**
 * Open the Print page when the app starts. Only the initial "/" is redirected,
 * so the Designer (also at "/") stays reachable from the sidebar afterwards.
 */
function StartOnPrint() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    if (pathname === "/") navigate("/print", { replace: true });
    // Run once on launch, not on every later visit to "/".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function AppContent() {
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(() => {
    try { return localStorage.getItem("printninja-onboarding-complete") === "true"; } catch { return null; }
  });
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    diagnostics.info("App started", { platform: navigator.platform });
  }, []);

  // DB is source of truth, localStorage is cache. Wait for DB before deciding
  // to avoid flashing onboarding on every reload.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await agent("get_setting", { key: "onboarding_done" }).catch(() => null);
        if (cancelled) return;
        if (v === "true") {
          try { localStorage.setItem("printninja-onboarding-complete", "true"); } catch {}
          setOnboardingComplete(true);
        } else if (v === "false" || v === null) {
          // DB says not done — respect it even if localStorage says true (reinstall/cleared DB)
          const lsDone = (() => { try { return localStorage.getItem("printninja-onboarding-complete") === "true"; } catch { return false; }})();
          if (lsDone && v === null) {
            // DB cleared but LS says done — reinstall, clear LS and re-show
            try { localStorage.removeItem("printninja-onboarding-complete"); } catch {}
            setOnboardingComplete(false);
          } else if (lsDone && v === "false") {
            try { localStorage.removeItem("printninja-onboarding-complete"); } catch {}
            setOnboardingComplete(false);
          } else if (!lsDone) {
            setOnboardingComplete(false);
            diagnostics.info("First run detected, showing onboarding");
          }
        }
      } catch {
        // Web mode: rely on localStorage only
        const lsDone = (() => { try { return localStorage.getItem("printninja-onboarding-complete") === "true"; } catch { return false; }})();
        setOnboardingComplete(lsDone);
        if (!lsDone) diagnostics.info("First run detected, showing onboarding");
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    // Also handle case where invoke never resolves (web mode) — fallback after 500ms
    const timer = setTimeout(() => { if (!cancelled) setChecking(false); }, 600);
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  const handleOnboardingComplete = async (destination?: string) => {
    localStorage.setItem("printninja-onboarding-complete", "true");
    try {
      await agent("set_setting", { key: "onboarding_done", value: "true" }).catch(() => {});
    } catch {}
    // The router has not mounted yet, so set the starting address before it does.
    if (destination) window.history.replaceState(null, "", destination);
    setOnboardingComplete(true);
    diagnostics.info("Onboarding completed");
  };

  if (checking && onboardingComplete === null) {
    return <div className="min-h-screen flex items-center justify-center bg-background"><div className="h-6 w-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  }
  if (!onboardingComplete) {
    return <Onboarding onComplete={handleOnboardingComplete} />;
  }

  return (
    <BrowserRouter>
      <StartOnPrint />
      <Layout>
        <Routes>
          <Route path="/" element={<DesignerPage />} />
          <Route path="/template/:id" element={<DesignerPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/print" element={<PrintPage />} />
          <Route path="/printers" element={<PrinterSetupPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          {UiKitPage && (
            <Route
              path="/__ui"
              element={
                <Suspense fallback={null}>
                  <UiKitPage />
                </Suspense>
              }
            />
          )}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
