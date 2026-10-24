import { useEffect, useState } from "react";

/**
 * Manual update check (no auto-download, no Tauri updater): compare the
 * running app version against the latest GitHub Release and, when newer,
 * point the user at the release page to update by hand.
 */

/** GitHub repo whose releases are the update source. */
const UPDATE_REPO = "sayed-rafi-bd/PrintNinja";
const CHECK_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
const CACHE_KEY = "printninja-update-check";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export interface UpdateInfo {
  /** Normalised version without a leading v, e.g. "3.2.0". */
  version: string;
  /** Release page to open for a manual update. */
  url: string;
}

/** "v3.2.0" -> "3.2.0". */
export function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, "");
}

/**
 * Current app version. Tauri builds read it from the bundle; web builds use
 * the package.json version baked in by vite (see vite.config.ts), so the
 * value always tracks what release.mjs bumps.
 */
export async function getAppVersion(): Promise<string> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    const v = await getVersion();
    if (typeof v === "string" && v.trim()) return normalizeVersion(v);
  } catch {
    // Web mode (or mocked Tauri): fall through to the baked version.
  }
  const baked =
    typeof __APP_VERSION__ === "string" && __APP_VERSION__
      ? __APP_VERSION__
      : "0.0.0";
  return normalizeVersion(baked);
}

/** True when `latest` is a strictly higher dotted version than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) =>
    normalizeVersion(v)
      .split(".")
      .map((p) => {
        const n = parseInt(p, 10);
        return Number.isNaN(n) ? 0 : n;
      });
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

interface CacheEntry extends UpdateInfo {
  checkedAt: number;
}

function readCache(): (UpdateInfo & { fresh: boolean }) | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as Partial<CacheEntry>;
    if (typeof entry.version !== "string" || typeof entry.url !== "string")
      return null;
    return {
      version: entry.version,
      url: entry.url,
      fresh: Date.now() - (entry.checkedAt ?? 0) < CHECK_INTERVAL_MS,
    };
  } catch {
    return null;
  }
}

function writeCache(info: UpdateInfo): void {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ ...info, checkedAt: Date.now() }),
    );
  } catch {
    // Storage full or private mode: the check just runs again next boot.
  }
}

/** Latest published release, or null when it cannot be determined. Never throws. */
export async function fetchLatestRelease(
  signal?: AbortSignal,
): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(CHECK_URL, {
      signal,
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      tag_name?: unknown;
      html_url?: unknown;
    };
    if (typeof body.tag_name !== "string" || typeof body.html_url !== "string")
      return null;
    return { version: normalizeVersion(body.tag_name), url: body.html_url };
  } catch {
    // Offline, DNS, CORS, timeout, abort: an update check never blocks the UI.
    return null;
  }
}

/**
 * Background update state for the topbar badge. Starts from the cache (if
 * any), revalidates at most once a day, and stays silent on every failure.
 */
export function useUpdateCheck(): {
  available: boolean;
  version: string;
  url: string;
} {
  const [info, setInfo] = useState<UpdateInfo | null>(() => {
    const cached = readCache();
    return cached ? { version: cached.version, url: cached.url } : null;
  });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    (async () => {
      const current = await getAppVersion();
      if (cancelled) return;
      // The app may have been updated since the cache was written.
      setInfo((prev) =>
        prev && !isNewer(prev.version, current) ? null : prev,
      );
      if (readCache()?.fresh) return;
      const latest = await fetchLatestRelease(controller.signal);
      clearTimeout(timer);
      if (cancelled || !latest) return;
      if (isNewer(latest.version, current)) {
        writeCache(latest);
        setInfo(latest);
      } else {
        setInfo(null);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  return {
    available: info != null,
    version: info?.version ?? "",
    url: info?.url ?? "",
  };
}

/**
 * Open a URL outside the app. Tauri webviews do not open external anchors
 * on their own, so the opener plugin handles it there; browsers use a tab.
 * (Link opening only — this is not the Tauri updater.)
 */
export async function openExternalUrl(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
