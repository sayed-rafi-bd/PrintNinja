import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { readCachedSetting, readSetting, writeSetting } from "@/lib/settings";
import { notifyLocalEdit } from "@/lib/sync/useSyncStatus";
import {
  DEFAULT_APP_NAME,
  SETTING_KEYS,
  isValidLogoDataUrl,
  parseDensity,
  sanitizeAppName,
  windowTitle,
  type Density,
} from "./prefs";

interface Prefs {
  density: Density;
  appName: string;
  /** Data URL of the custom logo, or null for the built-in PrintNinja mark. */
  logo: string | null;
  setDensity: (d: Density) => Promise<void>;
  setAppName: (name: string) => Promise<void>;
  setLogo: (dataUrl: string | null) => Promise<void>;
}

const noop = async () => {};
const DEFAULTS: Prefs = {
  density: "comfortable",
  appName: DEFAULT_APP_NAME,
  logo: null,
  setDensity: noop,
  setAppName: noop,
  setLogo: noop,
};

// Without a provider (tests, isolated components) everything falls back to defaults.
const PrefsContext = createContext<Prefs>(DEFAULTS);
export const usePrefs = () => useContext(PrefsContext);

async function setNativeWindowTitle(title: string) {
  if (
    typeof window === "undefined" ||
    !(window as unknown as { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__
  )
    return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(title);
  } catch {
    /* title stays as configured in tauri.conf.json */
  }
}

export function PrefsProvider({ children }: { children: React.ReactNode }) {
  // Start from the local cache so the first paint already has the right density and name.
  const [density, setDensityState] = useState<Density>(() =>
    parseDensity(readCachedSetting(SETTING_KEYS.density)),
  );
  const [appName, setAppNameState] = useState(() =>
    sanitizeAppName(readCachedSetting(SETTING_KEYS.appName)),
  );
  const [logo, setLogoState] = useState<string | null>(() => {
    const v = readCachedSetting(SETTING_KEYS.logo);
    return isValidLogoDataUrl(v) ? v : null;
  });

  useEffect(() => {
    let cancelled = false;
    const readAll = async () => {
      const [d, n, l] = await Promise.all([
        readSetting(SETTING_KEYS.density),
        readSetting(SETTING_KEYS.appName),
        readSetting(SETTING_KEYS.logo),
      ]);
      if (cancelled) return;
      setDensityState(parseDensity(d));
      setAppNameState(sanitizeAppName(n));
      setLogoState(isValidLogoDataUrl(l) ? l : null);
    };
    void readAll();
    // A completed pull may bring another PC's preferences; re-read so
    // the new values apply with no reload (F11).
    const onPulled = () => void readAll();
    window.addEventListener("sync:pulled", onPulled);
    return () => {
      cancelled = true;
      window.removeEventListener("sync:pulled", onPulled);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  useEffect(() => {
    const title = windowTitle(appName);
    document.title = title;
    void setNativeWindowTitle(title);
  }, [appName]);

  const setDensity = useCallback(async (d: Density) => {
    setDensityState(d);
    await writeSetting(SETTING_KEYS.density, d);
    // An account preference: push it soon so the other PC pulls it.
    notifyLocalEdit();
  }, []);
  const setAppName = useCallback(async (name: string) => {
    const clean = sanitizeAppName(name);
    setAppNameState(clean);
    // Store empty for the default so "reset" really clears the override.
    await writeSetting(
      SETTING_KEYS.appName,
      clean === DEFAULT_APP_NAME ? "" : clean,
    );
    notifyLocalEdit();
  }, []);
  const setLogo = useCallback(async (dataUrl: string | null) => {
    const next = isValidLogoDataUrl(dataUrl) ? dataUrl : null;
    setLogoState(next);
    await writeSetting(SETTING_KEYS.logo, next ?? "");
    notifyLocalEdit();
  }, []);

  const value = useMemo(
    () => ({ density, appName, logo, setDensity, setAppName, setLogo }),
    [density, appName, logo, setDensity, setAppName, setLogo],
  );
  return (
    <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>
  );
}
