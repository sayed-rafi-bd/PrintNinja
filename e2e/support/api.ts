// Typed HTTP helper for the service under test. Used by fixtures (to
// create users before a page loads) and by specs that drive the API
// directly. Shapes mirror the Zod schemas in server/src/http/schemas.
// The service URL comes from the global setup's stack file — specs run
// in their own processes and never inherit the setup's environment.

export interface ApiUser {
  id: string;
  handle: string;
  created_at: string;
}

export interface AuthResponse {
  token: string;
  expires_at: string;
  user: ApiUser;
}

import { readStackState } from "./stack-state.js";

export interface ApiError {
  status: number;
  code: string;
  message: string;
}

function apiUrl(): string {
  try {
    return readStackState().apiUrl;
  } catch {
    throw new Error(
      "e2e stack file missing — run through the e2e global setup",
    );
  }
}

async function request<T>(
  method: string,
  path: string,
  init?: { body?: unknown; token?: string },
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (init?.token !== undefined) {
    headers.authorization = `Bearer ${init.token}`;
  }
  const response = await fetch(`${apiUrl()}${path}`, {
    method,
    headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (response.status === 204) {
    return undefined as T;
  }
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  if (!response.ok) {
    const error: ApiError = {
      status: response.status,
      code: payload.error?.code ?? "unknown",
      message: payload.error?.message ?? response.statusText,
    };
    throw Object.assign(
      new Error(`API ${method} ${path}: ${error.status} ${error.code}`),
      { apiError: error },
    );
  }
  return payload as T;
}

export function apiRegister(
  handle: string,
  password: string,
): Promise<AuthResponse> {
  return request<AuthResponse>("POST", "/v2/auth/register", {
    body: { handle, password },
  });
}

export function apiLogin(
  handle: string,
  password: string,
): Promise<AuthResponse> {
  return request<AuthResponse>("POST", "/v2/auth/login", {
    body: { handle, password },
  });
}

export function apiMe(token: string): Promise<ApiUser> {
  return request<ApiUser>("GET", "/v2/auth/me", { token });
}

export function apiLogout(token: string): Promise<void> {
  return request<void>("POST", "/v2/auth/logout", { token });
}

export interface ApiTemplateSummary {
  id: string;
  name: string;
  published_at: string | null;
}

export function apiMine(
  token: string,
): Promise<{ items: ApiTemplateSummary[] }> {
  return request<{ items: ApiTemplateSummary[] }>(
    "GET",
    "/v2/templates/mine?page=1&page_size=100",
    { token },
  );
}

export function apiCommunity(
  token: string,
  q = "",
): Promise<{ items: ApiTemplateSummary[] }> {
  const params = new URLSearchParams({
    page: "1",
    page_size: "100",
    sort: "updated",
  });
  if (q) {
    params.set("q", q);
  }
  return request<{ items: ApiTemplateSummary[] }>(
    "GET",
    `/v2/community/templates?${params.toString()}`,
    { token },
  );
}

export interface ApiVersion {
  version_no: number;
  body: string;
}

export function apiVersions(
  token: string,
  id: string,
): Promise<{ items: ApiVersion[] }> {
  return request<{ items: ApiVersion[] }>(
    "GET",
    `/v2/templates/${id}/versions?page=1&page_size=5`,
    { token },
  );
}

export interface ApiSyncChange {
  seq: string;
  entity: string;
  op: string;
  data?: { id?: string; key?: string };
  id?: string;
}

/** The delta stream, for specs that wait on a push to land server-side. */
export function apiSyncChanges(
  token: string,
  types = "template,dataset,profile,setting,font",
): Promise<{
  changes: ApiSyncChange[];
  next_cursor: string;
  has_more: boolean;
  reset: boolean;
}> {
  return request("GET", `/v2/sync/changes?limit=100&types=${types}`, { token });
}

export function apiVersion(
  token: string,
  id: string,
  n: number,
): Promise<{ body: string }> {
  return request<{ body: string }>("GET", `/v2/templates/${id}/versions/${n}`, {
    token,
  });
}

export interface ApiPutTemplateInput {
  name: string;
  summary?: string;
  page_w_mm?: number;
  page_h_mm?: number;
  language?: string;
  body: string;
  css?: string;
  readme?: string;
  if_revision?: number;
}

export function apiPutTemplate(
  token: string,
  id: string,
  input: ApiPutTemplateInput,
): Promise<{ id: string; revision: number }> {
  const { if_revision, name, ...rest } = input;
  return request("PUT", `/v2/templates/${id}`, {
    token,
    body: {
      name,
      summary: "",
      page_w_mm: 210,
      page_h_mm: 297,
      language: "html",
      css: "",
      ...rest,
      ...(if_revision === undefined ? {} : { if_revision }),
    },
  });
}

export function apiPublish(
  token: string,
  id: string,
): Promise<{ id: string; revision: number }> {
  return request("POST", `/v2/templates/${id}/publish`, { token });
}

export function apiUnpublish(
  token: string,
  id: string,
): Promise<{ id: string; revision: number }> {
  return request("POST", `/v2/templates/${id}/unpublish`, { token });
}

export function apiSaveTemplate(token: string, id: string): Promise<void> {
  return request("PUT", `/v2/saved/${id}`, { token });
}

export function apiUnsaveTemplate(token: string, id: string): Promise<void> {
  return request("DELETE", `/v2/saved/${id}`, { token });
}

export function apiPutDataset(
  token: string,
  id: string,
  input: { name: string; dataJson?: string; if_revision?: number },
): Promise<{ id: string; revision: number }> {
  const { if_revision, ...rest } = input;
  return request("PUT", `/v2/datasets/${id}`, {
    token,
    body: {
      ...rest,
      ...(if_revision === undefined ? {} : { if_revision }),
    },
  });
}

export function apiDeleteDataset(token: string, id: string): Promise<void> {
  return request("DELETE", `/v2/datasets/${id}`, { token });
}

export function apiPutProfile(
  token: string,
  id: string,
  input: {
    template_id: string;
    printer_name: string;
    settings_json?: string;
    if_revision?: number;
  },
): Promise<{ id: string; revision: number }> {
  const { if_revision, ...rest } = input;
  return request("PUT", `/v2/profiles/${id}`, {
    token,
    body: {
      ...rest,
      ...(if_revision === undefined ? {} : { if_revision }),
    },
  });
}

export function apiDeleteProfile(token: string, id: string): Promise<void> {
  return request("DELETE", `/v2/profiles/${id}`, { token });
}

export function apiPutSetting(
  token: string,
  key: string,
  value: string,
): Promise<{ key: string; value: string }> {
  return request("PUT", `/v2/settings/${key}`, { token, body: { value } });
}

export function apiDeleteSetting(token: string, key: string): Promise<void> {
  return request("DELETE", `/v2/settings/${key}`, { token });
}

export function apiPutFont(
  token: string,
  id: string,
  input: { name: string; if_revision?: number },
): Promise<{ id: string; revision: number }> {
  const { if_revision, ...rest } = input;
  return request("PUT", `/v2/fonts/${id}`, {
    token,
    body: {
      ...rest,
      ...(if_revision === undefined ? {} : { if_revision }),
    },
  });
}

/** Raw octet-stream upload (the JSON helper cannot carry font bytes). */
export async function apiPutFontFile(
  token: string,
  id: string,
  bytes: Uint8Array,
): Promise<{ id: string; size_bytes: number }> {
  const response = await fetch(`${apiUrl()}/v2/fonts/${id}/file`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
    },
    body: bytes as unknown as BodyInit,
  });
  if (response.ok) {
    return (await response.json().catch(() => ({}))) as {
      id: string;
      size_bytes: number;
    };
  }
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  throw Object.assign(
    new Error(
      `API PUT /v2/fonts/${id}/file: ${response.status} ${payload.error?.code ?? response.statusText}`,
    ),
    {
      apiError: {
        status: response.status,
        code: payload.error?.code ?? "unknown",
        message: payload.error?.message ?? response.statusText,
      } satisfies ApiError,
    },
  );
}
