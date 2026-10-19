/**
 * Share service client — thin HTTP wrapper for the hosted service (V2.md §10).
 * The app holds no database credentials; it only talks to the service over HTTPS
 * with a Bearer token stored in local settings.
 */

const SETTINGS_KEYS = {
  serviceUrl: "share_service_url",
  token: "share_session_token",
} as const;

async function getSetting(key: string): Promise<string | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string | null>("get_setting", { key });
  } catch {
    try {
      return localStorage.getItem(`printninja-setting:${key}`);
    } catch {
      return null;
    }
  }
}

async function setSetting(key: string, value: string | null): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    if (value === null) {
      // No delete_setting command; set to empty and treat as missing on read
      await invoke("set_setting", { key, value: "" });
    } else {
      await invoke("set_setting", { key, value });
    }
  } catch {
    try {
      if (value === null) {
        localStorage.removeItem(`printninja-setting:${key}`);
      } else {
        localStorage.setItem(`printninja-setting:${key}`, value);
      }
    } catch {}
  }
}

export async function getServiceUrl(): Promise<string | null> {
  const v = await getSetting(SETTINGS_KEYS.serviceUrl);
  return v && v.trim() ? v.trim().replace(/\/$/, "") : null;
}

export async function setServiceUrl(url: string | null): Promise<void> {
  await setSetting(SETTINGS_KEYS.serviceUrl, url);
}

export async function getSessionToken(): Promise<string | null> {
  const v = await getSetting(SETTINGS_KEYS.token);
  return v && v.trim() ? v.trim() : null;
}

export async function setSessionToken(token: string | null): Promise<void> {
  await setSetting(SETTINGS_KEYS.token, token);
}

export async function isSignedIn(): Promise<boolean> {
  return (await getSessionToken()) != null;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getSessionToken();
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

/** The server could not be reached at all (network down, wrong address, timeout). */
export class ServerUnreachableError extends Error {
  constructor(public readonly url: string) {
    super(`Cannot reach the server at ${url}`);
    this.name = "ServerUnreachableError";
  }
}

/** The server answered 401: the stored session is no longer valid. */
export class SessionExpiredError extends Error {
  constructor() {
    super("Your session has ended. Sign in again.");
    this.name = "SessionExpiredError";
  }
}

// --- Session lifecycle -------------------------------------------------------
// The sign-in gate listens for this so any 401, or a sign-out, returns the
// person to the sign-in screen without each caller knowing about the gate.

const SESSION_ENDED_EVENT = "printninja:session-ended";

export type SessionEndReason = "expired" | "signed_out";

export function onSessionEnded(cb: (reason: SessionEndReason) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<SessionEndReason>).detail ?? "expired");
  window.addEventListener(SESSION_ENDED_EVENT, handler);
  return () => window.removeEventListener(SESSION_ENDED_EVENT, handler);
}

/** Forget the stored token and send the app back to sign-in. */
export async function endSession(reason: SessionEndReason = "expired"): Promise<void> {
  await setSessionToken(null);
  window.dispatchEvent(new CustomEvent<SessionEndReason>(SESSION_ENDED_EVENT, { detail: reason }));
}

/**
 * Signed-in request to the service. Throws ServerUnreachableError when the
 * network call fails, and on a 401 ends the session and throws
 * SessionExpiredError. Other statuses are returned for the caller to handle.
 */
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = await getServiceUrl();
  if (!base) throw new Error("Share service not configured");
  const headers = { ...(await authHeaders()), ...((init.headers as Record<string, string> | undefined) ?? {}) };
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...init, headers });
  } catch {
    throw new ServerUnreachableError(base);
  }
  if (res.status === 401) {
    await endSession("expired");
    throw new SessionExpiredError();
  }
  return res;
}

async function authRequest(
  path: "/v1/auth/register" | "/v1/auth/login",
  handle: string,
  password: string,
  failure: string,
): Promise<{ token: string; user: { id: string; handle: string } }> {
  const base = await getServiceUrl();
  if (!base) throw new Error("Share service not configured");
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle, password }),
    });
  } catch {
    throw new ServerUnreachableError(base);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `${failure}: ${res.status}`);
  }
  const data = await res.json();
  await setSessionToken(data.token);
  return data;
}

export async function register(handle: string, password: string): Promise<{ token: string; user: { id: string; handle: string } }> {
  return authRequest("/v1/auth/register", handle, password, "Register failed");
}

export async function login(handle: string, password: string): Promise<{ token: string; user: { id: string; handle: string } }> {
  return authRequest("/v1/auth/login", handle, password, "Login failed");
}

export async function logout(): Promise<void> {
  const base = await getServiceUrl();
  const token = await getSessionToken();
  if (base && token) {
    try {
      await fetch(`${base}/v1/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {}
  }
  await endSession("signed_out");
}

export interface PublishPayload {
  id: string; // UUID, client-generated
  name: string;
  summary: string;
  page_w_mm: number;
  page_h_mm: number;
  language: string;
  body: string;
  readme: string;
}

export async function publishTemplate(payload: PublishPayload): Promise<any> {
  const res = await authedFetch(`/v1/templates/${payload.id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Publish failed: ${res.status}`);
  }
  return res.json();
}

export async function unpublishTemplate(id: string): Promise<void> {
  const res = await authedFetch(`/v1/templates/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Unpublish failed: ${res.status}`);
  }
}

// For the Designer state chip / strip
export function isPublished(template: { remote_id: string | null; published_at: string | null }): boolean {
  return !!template.remote_id;
}

export function hasUnpublishedChanges(template: { remote_id: string | null; published_at: string | null; updated_at: string }): boolean {
  if (!template.remote_id || !template.published_at) return false;
  // published_at and updated_at are ISO strings; lexical compare works for RFC3339, but parse to be safe
  return new Date(template.updated_at) > new Date(template.published_at);
}
