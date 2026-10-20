/**
 * Start-up session check for the sign-in gate.
 *
 * It answers one question: can this PC use the app right now? Signed in with a
 * session the server still accepts, signed out (show sign-in), or the server
 * could not be reached (show the "cannot reach server" screen).
 */
import { getServiceUrl, getSessionToken, setSessionToken } from "./client";

export type SessionCheck =
  | { state: "signed_in"; handle: string }
  | { state: "signed_out"; url: string | null }
  | { state: "unreachable"; url: string };

const TIMEOUT_MS = 5_000;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Accepts a full http(s) address and returns it without a trailing slash, or
 * null when it is not a usable address.
 */
export function normalizeServiceUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    return trimmed.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Never throws. A stored token the server rejects with 401 is removed. */
export async function checkSession(): Promise<SessionCheck> {
  const url = await getServiceUrl();
  if (!url) return { state: "signed_out", url: null };

  const token = await getSessionToken();
  try {
    if (token) {
      const res = await fetchWithTimeout(`${url}/v2/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const u = (await res.json().catch(() => ({}))) as { handle?: string };
        return { state: "signed_in", handle: u.handle ?? "" };
      }
      if (res.status === 401) {
        await setSessionToken(null);
        return { state: "signed_out", url };
      }
      return { state: "unreachable", url };
    }

    // No session yet: make sure the server is there before asking for a password.
    const res = await fetchWithTimeout(`${url}/v2/health`);
    return res.ok ? { state: "signed_out", url } : { state: "unreachable", url };
  } catch {
    return { state: "unreachable", url };
  }
}

/** Never throws. True when the app can open without the server: a stored
 * session plus at least one cached template to work with. Anything else
 * (no token, empty cache, no local agent) means the unreachable screen. */
export async function canOpenOffline(): Promise<boolean> {
  try {
    const token = await getSessionToken();
    if (!token) return false;
    const { invoke } = await import("@/lib/invoke");
    const templates = await invoke<unknown[]>("list_templates");
    return Array.isArray(templates) && templates.length > 0;
  } catch {
    return false;
  }
}
