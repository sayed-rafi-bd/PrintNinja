/**
 * Share service client — thin HTTP wrapper for the hosted service.
 * Auth and identity go through the typed v2 client (src/lib/api/);
 * template, community and saved calls still use the v1 endpoints until
 * the app switch reaches them in a later Phase 3 slice.
 * The app holds no database credentials; it only talks to the service
 * over HTTPS with a Bearer token stored in local settings.
 */
import { callApi, type ApiDeps } from "@/lib/api/client";
import { agent } from "@/lib/agent/commands";
import type { paths } from "@/lib/api/schema";
import {
  ApiError,
  ServerUnreachableError,
  SessionExpiredError,
} from "@/lib/api/errors";

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
    return await agent("get_setting", { key });
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
    if (value === null) {
      // No delete_setting command; set to empty and treat as missing on read
      await agent("set_setting", { key, value: "" });
    } else {
      await agent("set_setting", { key, value });
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

export function onSessionEnded(
  cb: (reason: SessionEndReason) => void,
): () => void {
  const handler = (e: Event) =>
    cb((e as CustomEvent<SessionEndReason>).detail ?? "expired");
  window.addEventListener(SESSION_ENDED_EVENT, handler);
  return () => window.removeEventListener(SESSION_ENDED_EVENT, handler);
}

/** Forget the stored token and send the app back to sign-in. */
export async function endSession(
  reason: SessionEndReason = "expired",
): Promise<void> {
  await setSessionToken(null);
  window.dispatchEvent(
    new CustomEvent<SessionEndReason>(SESSION_ENDED_EVENT, { detail: reason }),
  );
}

/**
 * Signed-in request to the service. Throws ServerUnreachableError when the
 * network call fails, and on a 401 ends the session and throws
 * SessionExpiredError. Other statuses are returned for the caller to handle.
 */
export async function authedFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const base = await getServiceUrl();
  if (!base) throw new Error("Share service not configured");
  const headers = {
    ...(await authHeaders()),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
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

export async function register(
  handle: string,
  password: string,
): Promise<AuthResponse> {
  return authRequest("/v2/auth/register", handle, password);
}

export async function login(
  handle: string,
  password: string,
): Promise<AuthResponse> {
  return authRequest("/v2/auth/login", handle, password);
}

/** Who the stored session belongs to. 401s end the session via callApi. */
export async function fetchMe(): Promise<{ id: string; handle: string }> {
  return callApi<{ id: string; handle: string }>(apiDeps(), {
    method: "GET",
    path: "/v2/auth/me",
  });
}

export async function logout(): Promise<void> {
  try {
    await callApi<unknown>(apiDeps(), {
      method: "POST",
      path: "/v2/auth/logout",
    });
  } catch {
    // Best effort: an expired or missing token still signs out below.
    // A 401 already cleared the token through onUnauthorized.
  } finally {
    await endSession("signed_out");
  }
}

/** A template as the v2 service stores it. `published_at` is null when
 * private (v1 used an empty string); every existing falsy check keeps
 * working unchanged. */
export type RemoteTemplate =
  paths["/v2/templates/{id}"]["get"]["responses"][200]["content"]["application/json"];

/** A template as the v2 service lists it. */
export type RemoteTemplateSummary =
  paths["/v2/templates/mine"]["get"]["responses"][200]["content"]["application/json"]["items"][number];

export interface PutTemplateInput {
  id: string;
  name: string;
  summary?: string;
  page_w_mm: number;
  page_h_mm: number;
  language?: "html";
  body: string;
  css?: string;
  readme?: string;
  if_revision?: number;
  /** Labelled saves record a version; the server appends one when the
   * body or CSS changed. */
  version?: { label?: string | null; note?: string | null };
}

/** Create or update a template by client UUID. Updates need if_revision. */
export async function putRemoteTemplate(
  input: PutTemplateInput,
): Promise<RemoteTemplate> {
  const { version, ...rest } = input;
  // The schema takes optional strings, not nulls.
  const body = {
    ...rest,
    ...(version
      ? {
          version: {
            ...(version.label != null ? { label: version.label } : {}),
            ...(version.note != null ? { note: version.note } : {}),
          },
        }
      : {}),
  };
  return callApi<RemoteTemplate>(apiDeps(), {
    method: "PUT",
    path: `/v2/templates/${input.id}`,
    body,
  });
}

/** Make a template public, keeping the first publish time. */
export async function publishRemoteTemplate(
  id: string,
): Promise<RemoteTemplate> {
  return callApi<RemoteTemplate>(apiDeps(), {
    method: "POST",
    path: `/v2/templates/${id}/publish`,
  });
}

/** Make a template private. The server copy is kept. */
export async function unpublishRemoteTemplate(id: string): Promise<void> {
  await callApi<unknown>(apiDeps(), {
    method: "POST",
    path: `/v2/templates/${id}/unpublish`,
  });
}

export async function unpublishTemplate(id: string): Promise<void> {
  // v1 DELETE removed the server copy; the v2 equivalent that keeps the
  // detach-and-clear-local-state behavior is DELETE, not POST /unpublish
  // (which would keep a private copy on the server). Missing is fine —
  // the end state is the same.
  try {
    await callApi<unknown>(apiDeps(), {
      method: "DELETE",
      path: `/v2/templates/${id}`,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return;
    }
    throw err;
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
  try {
    return await callApi<RemoteTemplate>(apiDeps(), {
      method: "GET",
      path: `/v2/templates/${id}`,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new RemoteTemplateNotFoundError(id);
    }
    throw err;
  }
}

/** The signed-in user's own templates, private and published. Pages through the v2 list. */
export async function fetchMyRemoteTemplates(): Promise<
  RemoteTemplateSummary[]
> {
  return fetchAllPages((page, pageSize) =>
    callApi<{ items: RemoteTemplateSummary[]; has_more: boolean }>(apiDeps(), {
      method: "GET",
      path: `/v2/templates/mine?page=${page}&page_size=${pageSize}`,
    }),
  );
}

/** A community template as the v2 service lists it. */
export type CommunitySummary =
  paths["/v2/community/templates"]["get"]["responses"][200]["content"]["application/json"]["items"][number];

/** Search and sort the community gallery (one page; the gallery does not paginate yet). */
export async function fetchCommunityTemplates(options: {
  q?: string;
  sort?: "updated" | "used" | "name";
}): Promise<CommunitySummary[]> {
  const params = new URLSearchParams();
  params.set("page", "1");
  params.set("page_size", "100");
  if (options.q?.trim()) params.set("q", options.q.trim());
  if (options.sort) params.set("sort", options.sort);
  const page = await callApi<{ items: CommunitySummary[] }>(apiDeps(), {
    method: "GET",
    path: `/v2/community/templates?${params.toString()}`,
  });
  return page.items;
}

/** One server version: number, label/note, author and time. Bodies
 * come from readRemoteVersion — the list stays light. */
export type RemoteVersionSummary =
  paths["/v2/templates/{id}/versions"]["get"]["responses"][200]["content"]["application/json"]["items"][number];

/** A server version with its body and CSS. */
export type RemoteVersion =
  paths["/v2/templates/{id}/versions/{n}"]["get"]["responses"][200]["content"]["application/json"];

/** Version history, newest first (one page; panels show the latest 20). */
export async function listRemoteVersions(
  id: string,
): Promise<RemoteVersionSummary[]> {
  const page = await callApi<{ items: RemoteVersionSummary[] }>(apiDeps(), {
    method: "GET",
    path: `/v2/templates/${id}/versions?page=1&page_size=20`,
  });
  return page.items;
}

/** One version with its body and CSS. */
export async function readRemoteVersion(
  id: string,
  n: number,
): Promise<RemoteVersion> {
  return callApi<RemoteVersion>(apiDeps(), {
    method: "GET",
    path: `/v2/templates/${id}/versions/${n}`,
  });
}

/**
 * Copy a version's body and CSS into the template as a new revision.
 * The caller passes the revision the dialog was looking at; a stale one
 * 409s instead of overwriting a newer edit.
 */
export async function restoreRemoteVersion(
  id: string,
  n: number,
  ifRevision?: number,
): Promise<RemoteTemplate> {
  return callApi<RemoteTemplate>(apiDeps(), {
    method: "POST",
    path: `/v2/templates/${id}/versions/${n}/restore`,
    body: ifRevision === undefined ? {} : { if_revision: ifRevision },
  });
}

/** Delete one version. The newest cannot be deleted. */
export async function deleteRemoteVersion(
  id: string,
  n: number,
): Promise<void> {
  await callApi<unknown>(apiDeps(), {
    method: "DELETE",
    path: `/v2/templates/${id}/versions/${n}`,
  });
}

/** The community templates the signed-in user has saved. */
export async function fetchSavedRemoteTemplates(): Promise<
  RemoteTemplateSummary[]
> {
  return fetchAllPages((page, pageSize) =>
    callApi<{ items: RemoteTemplateSummary[]; has_more: boolean }>(apiDeps(), {
      method: "GET",
      path: `/v2/saved?page=${page}&page_size=${pageSize}`,
    }),
  );
}

async function fetchAllPages(
  fetchPage: (
    page: number,
    pageSize: number,
  ) => Promise<{ items: RemoteTemplateSummary[]; has_more: boolean }>,
): Promise<RemoteTemplateSummary[]> {
  const out: RemoteTemplateSummary[] = [];
  let page = 1;
  for (;;) {
    const { items, has_more } = await fetchPage(page, 100);
    out.push(...items);
    if (!has_more) {
      return out;
    }
    page += 1;
  }
}

/** Keeps a community template in the user's Saved list. Idempotent. */
export async function saveRemoteTemplate(id: string): Promise<void> {
  await callApi<unknown>(apiDeps(), { method: "PUT", path: `/v2/saved/${id}` });
}

/** Takes a community template out of the user's Saved list. Always 204. */
export async function unsaveRemoteTemplate(id: string): Promise<void> {
  await callApi<unknown>(apiDeps(), {
    method: "DELETE",
    path: `/v2/saved/${id}`,
  });
}

// --- Sample datasets (endpoints 23-24) --------------------------------------
// Account-level named JSON blobs for the Designer's sample-data panel.
// There is no list endpoint: the sync stream is the read path.

/** A sample dataset as the v2 service stores it. */
export type RemoteDataset =
  paths["/v2/datasets/{id}"]["put"]["responses"][200]["content"]["application/json"];

export interface PutRemoteDatasetInput {
  id: string;
  name: string;
  data_json?: string;
  if_revision?: number;
}

/** Create or update a dataset by client UUID. Updates need if_revision. */
export async function putRemoteDataset(
  input: PutRemoteDatasetInput,
): Promise<RemoteDataset> {
  // The write schema takes camelCase; everything app-side stays snake_case.
  const { data_json, ...rest } = input;
  return callApi<RemoteDataset>(apiDeps(), {
    method: "PUT",
    path: `/v2/datasets/${input.id}`,
    body: data_json === undefined ? rest : { ...rest, dataJson: data_json },
  });
}

/** Delete a dataset. The engine treats 404 as already gone. */
export async function deleteRemoteDataset(id: string): Promise<void> {
  await callApi<unknown>(apiDeps(), {
    method: "DELETE",
    path: `/v2/datasets/${id}`,
  });
}

// --- Printer profiles (endpoints 25-26) --------------------------------------
// One row per template and lowercased printer name. No list endpoint:
// the sync stream is the read path.

/** A printer profile as the v2 service stores it. */
export type RemoteProfile =
  paths["/v2/profiles/{id}"]["put"]["responses"][200]["content"]["application/json"];

export interface PutRemoteProfileInput {
  id: string;
  template_id: string;
  printer_name: string;
  settings_json?: string;
  if_revision?: number;
}

/** Create or update a profile by client UUID. Updates need if_revision. */
export async function putRemoteProfile(
  input: PutRemoteProfileInput,
): Promise<RemoteProfile> {
  return callApi<RemoteProfile>(apiDeps(), {
    method: "PUT",
    path: `/v2/profiles/${input.id}`,
    body: input,
  });
}

/** Delete a profile. The engine treats 404 as already gone. */
export async function deleteRemoteProfile(id: string): Promise<void> {
  await callApi<unknown>(apiDeps(), {
    method: "DELETE",
    path: `/v2/profiles/${id}`,
  });
}

// --- Account preferences (endpoints 27-28) ------------------------------------
// Only allow-listed keys (ui_density, brand_name, brand_logo) live here;
// everything else stays in the device settings table and never syncs.

/** An account preference as the v2 service stores it. */
export type RemoteSetting =
  paths["/v2/settings/{key}"]["put"]["responses"][200]["content"]["application/json"];

/** Set an account preference. Last writer wins; there are no revisions to send. */
export async function putRemoteSetting(
  key: string,
  value: string,
): Promise<RemoteSetting> {
  return callApi<RemoteSetting>(apiDeps(), {
    method: "PUT",
    path: `/v2/settings/${key}`,
    body: { value },
  });
}

/** Reset an account preference. Always 204, even when nothing was set. */
export async function deleteRemoteSetting(key: string): Promise<void> {
  await callApi<unknown>(apiDeps(), {
    method: "DELETE",
    path: `/v2/settings/${key}`,
  });
}

// --- Fonts (endpoints 29-32) ----------------------------------------------------
// Metadata and bytes are two calls; the bytes ride outside JSON.

/** A font as the v2 service stores it (metadata only, never the bytes). */
export type RemoteFont =
  paths["/v2/fonts/{id}"]["put"]["responses"][200]["content"]["application/json"];

export interface PutRemoteFontInput {
  id: string;
  name: string;
  if_revision?: number;
}

/** Create or update font metadata by client UUID. Updates need if_revision. */
export async function putRemoteFont(
  input: PutRemoteFontInput,
): Promise<RemoteFont> {
  return callApi<RemoteFont>(apiDeps(), {
    method: "PUT",
    path: `/v2/fonts/${input.id}`,
    body: input,
  });
}

/** A font that was never given bytes has no format, size or hash yet. */
export function isFontReady(font: Pick<RemoteFont, "sha256">): boolean {
  return font.sha256 !== "";
}

/** Upload font bytes. The server checks magic bytes, size and format. */
export async function uploadRemoteFontFile(
  id: string,
  bytes: Uint8Array,
): Promise<RemoteFont> {
  const res = await authedFetch(`/v2/fonts/${id}/file`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes as unknown as BodyInit,
  });
  if (!res.ok) {
    const envelope = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string; request_id?: string };
    } | null;
    throw new ApiError({
      code: envelope?.error?.code ?? "internal_error",
      message:
        envelope?.error?.message ?? `Font upload failed with ${res.status}`,
      requestId: envelope?.error?.request_id ?? "",
      status: res.status,
    });
  }
  return (await res.json()) as RemoteFont;
}

export interface DownloadedFontFile {
  bytes: Uint8Array;
  /** Hex SHA-256 from the ETag, the integrity check for the download. */
  sha256: string;
}

/** Download font bytes; the ETag carries the SHA-256. Verifies the hash. */
export async function downloadRemoteFontFile(
  id: string,
): Promise<DownloadedFontFile> {
  const res = await authedFetch(`/v2/fonts/${id}/file`, { method: "GET" });
  if (res.status === 404) {
    throw new ApiError({
      code: "not_found",
      message: "Font is not on the server",
      requestId: "",
      status: 404,
    });
  }
  if (!res.ok) {
    throw new ApiError({
      code: "internal_error",
      message: `Font download failed with ${res.status}`,
      requestId: "",
      status: res.status,
    });
  }
  const etag = res.headers.get("ETag") ?? "";
  const sha256 =
    etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1, -1) : etag;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  const actual = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (sha256 && actual !== sha256) {
    throw new Error("Font download failed the SHA-256 check");
  }
  return { bytes, sha256: actual };
}

/** Delete a font and its file. The engine treats 404 as already gone. */
export async function deleteRemoteFont(id: string): Promise<void> {
  await callApi<unknown>(apiDeps(), {
    method: "DELETE",
    path: `/v2/fonts/${id}`,
  });
}

// For the Designer state chip / strip. A template is public only when it has a
// publish time: `remote_id` alone means it is saved on the server as a private copy.
export function hasUnpublishedChanges(template: {
  remote_id: string | null;
  published_at: string | null;
  updated_at: string;
}): boolean {
  if (!template.remote_id || !template.published_at) return false;
  // published_at and updated_at are ISO strings; lexical compare works for RFC3339, but parse to be safe
  return new Date(template.updated_at) > new Date(template.published_at);
}
