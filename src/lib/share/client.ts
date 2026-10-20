/**
 * Share service client — thin HTTP wrapper for the hosted service.
 * Auth and identity go through the typed v2 client (src/lib/api/);
 * template, community and saved calls still use the v1 endpoints until
 * the app switch reaches them in a later Phase 3 slice.
 * The app holds no database credentials; it only talks to the service
 * over HTTPS with a Bearer token stored in local settings.
 */
import { callApi, type ApiDeps } from "@/lib/api/client";
import type { paths } from "@/lib/api/schema";
import { ApiError, ServerUnreachableError, SessionExpiredError } from "@/lib/api/errors";

export { ApiError, ServerUnreachableError, SessionExpiredError };

export type AuthResponse =
	paths["/v2/auth/register"]["post"]["responses"][201]["content"]["application/json"];

function apiDeps(): ApiDeps {
	return {
		getBaseUrl: getServiceUrl,
		getToken: getSessionToken,
		onUnauthorized: () => endSession("expired"),
	};
}

const SETTINGS_KEYS = {
  serviceUrl: "share_service_url",
  token: "share_session_token",
} as const;

async function getSetting(key: string): Promise<string | null> {
  try {
    const { invoke } = await import("@/lib/invoke");
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
    const { invoke } = await import("@/lib/invoke");
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
  path: "/v2/auth/register" | "/v2/auth/login",
  handle: string,
  password: string,
): Promise<AuthResponse> {
  const data = await callApi<AuthResponse>(apiDeps(), {
    method: "POST",
    path,
    body: { handle, password },
  });
  await setSessionToken(data.token);
  return data;
}

export async function register(handle: string, password: string): Promise<AuthResponse> {
  return authRequest("/v2/auth/register", handle, password);
}

export async function login(handle: string, password: string): Promise<AuthResponse> {
  return authRequest("/v2/auth/login", handle, password);
}

export async function logout(): Promise<void> {
  try {
    await callApi<unknown>(apiDeps(), { method: "POST", path: "/v2/auth/logout" });
  } catch {
    // Best effort: an expired or missing token still signs out below.
    // A 401 already cleared the token through onUnauthorized.
  } finally {
    await endSession("signed_out");
  }
}

export interface PublishPayload {
  id: string; // UUID, client-generated
  name: string;
  summary: string;
  page_w_mm: number;
  page_h_mm: number;
  language: string;
  body: string;
  /** Template CSS. Optional so an older server that does not know the column still accepts it. */
  css?: string;
  readme: string;
  /** Omit to keep the template's current visibility. `false` keeps it private. */
  publish?: boolean;
}

/** A template as the server stores it: name, HTML, CSS, page size and README. */
export interface RemoteTemplate {
  id: string;
  owner_id: string;
  owner_handle: string;
  name: string;
  summary: string;
  page_w_mm: number;
  page_h_mm: number;
  language: string;
  body: string;
  css: string;
  readme: string;
  use_count: number;
  published_at: string;
  updated_at: string;
}

/** A template as the server lists it: the same fields without body, css and readme. */
export type RemoteTemplateSummary = Omit<RemoteTemplate, "body" | "css" | "readme">;

export async function publishTemplate(payload: PublishPayload): Promise<RemoteTemplate> {
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

/** The server does not have this template, or will not show it to this user. */
export class RemoteTemplateNotFoundError extends Error {
  constructor(public readonly id: string) {
    super("That template is not on the server any more");
    this.name = "RemoteTemplateNotFoundError";
  }
}

/** The full stored copy of one template, CSS included. */
export async function fetchRemoteTemplate(id: string): Promise<RemoteTemplate> {
  const res = await authedFetch(`/v1/templates/${id}`);
  if (res.status === 404) throw new RemoteTemplateNotFoundError(id);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Could not get the template from the server: ${res.status}`);
  }
  return res.json();
}

/** The signed-in user's own templates, private and published. */
export async function fetchMyRemoteTemplates(): Promise<RemoteTemplateSummary[]> {
  const res = await authedFetch("/v1/templates/mine");
  if (!res.ok) throw new Error(`Could not list your templates: ${res.status}`);
  return res.json();
}

/** The community templates the signed-in user has saved. */
export async function fetchSavedRemoteTemplates(): Promise<RemoteTemplateSummary[]> {
  const res = await authedFetch("/v1/saved");
  if (!res.ok) throw new Error(`Could not list saved templates: ${res.status}`);
  return res.json();
}

/** Keeps a community template in the user's Saved list. Idempotent. */
export async function saveRemoteTemplate(id: string): Promise<void> {
  const res = await authedFetch(`/v1/saved/${id}`, { method: "PUT" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Could not save the template: ${res.status}`);
  }
}

/** Takes a community template out of the user's Saved list. */
export async function unsaveRemoteTemplate(id: string): Promise<void> {
  const res = await authedFetch(`/v1/saved/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Could not remove the template: ${res.status}`);
  }
}

// For the Designer state chip / strip. A template is public only when it has a
// publish time: `remote_id` alone means it is saved on the server as a private copy.
export function hasUnpublishedChanges(template: { remote_id: string | null; published_at: string | null; updated_at: string }): boolean {
  if (!template.remote_id || !template.published_at) return false;
  // published_at and updated_at are ISO strings; lexical compare works for RFC3339, but parse to be safe
  return new Date(template.updated_at) > new Date(template.published_at);
}
