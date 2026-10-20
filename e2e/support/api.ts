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
		throw new Error("e2e stack file missing — run through the e2e global setup");
	}
}

async function request<T>(method: string, path: string, init?: { body?: unknown; token?: string }): Promise<T> {
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
		throw Object.assign(new Error(`API ${method} ${path}: ${error.status} ${error.code}`), { apiError: error });
	}
	return payload as T;
}

export function apiRegister(handle: string, password: string): Promise<AuthResponse> {
	return request<AuthResponse>("POST", "/v2/auth/register", { body: { handle, password } });
}

export function apiLogin(handle: string, password: string): Promise<AuthResponse> {
	return request<AuthResponse>("POST", "/v2/auth/login", { body: { handle, password } });
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
}

export function apiMine(token: string): Promise<{ items: ApiTemplateSummary[] }> {
	return request<{ items: ApiTemplateSummary[] }>("GET", "/v2/templates/mine?page=1&page_size=100", { token });
}

export interface ApiVersion {
	version_no: number;
	body: string;
}

export function apiVersions(token: string, id: string): Promise<{ items: ApiVersion[] }> {
	return request<{ items: ApiVersion[] }>("GET", `/v2/templates/${id}/versions?page=1&page_size=5`, { token });
}

export function apiVersion(token: string, id: string, n: number): Promise<{ body: string }> {
	return request<{ body: string }>("GET", `/v2/templates/${id}/versions/${n}`, { token });
}
