import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./schema";
import { ApiError, isErrorEnvelope, ServerUnreachableError, SessionExpiredError } from "./errors";

export interface ApiDeps {
	/** The service base URL, without a trailing slash. Read fresh for
	 * every client build so a changed server address takes effect. */
	getBaseUrl: () => Promise<string | null>;
	getToken: () => Promise<string | null>;
	/** Called once when the service answers 401, before SessionExpiredError is thrown. */
	onUnauthorized: () => Promise<void> | void;
	fetch?: typeof globalThis.fetch;
}

export type ApiClient = ReturnType<typeof createClient<paths>>;

let cached: { baseUrl: string; fetch: typeof globalThis.fetch | undefined; client: ApiClient } | null = null;

function buildClient(baseUrl: string, deps: ApiDeps): ApiClient {
	const auth: Middleware = {
		async onRequest({ request }) {
			// callApi sets the header itself when it knows the token; the
			// middleware covers direct client users with the stored token.
			if (!request.headers.has("Authorization")) {
				const token = await deps.getToken();
				if (token) {
					request.headers.set("Authorization", `Bearer ${token}`);
				}
			}
			return request;
		},
	};
	const client = createClient<paths>({ baseUrl, fetch: deps.fetch });
	client.use(auth);
	return client;
}

/** The typed service client, rebuilt when the configured server address
 * changes. Every call site shares this one path to the network. */
export async function api(deps: ApiDeps): Promise<{ client: ApiClient; baseUrl: string }> {
	const baseUrl = await deps.getBaseUrl();
	if (!baseUrl) {
		throw new Error("Share service not configured");
	}
	if (!cached || cached.baseUrl !== baseUrl || cached.fetch !== deps.fetch) {
		cached = { baseUrl, fetch: deps.fetch, client: buildClient(baseUrl, deps) };
	}
	return cached;
}

export interface CallOptions {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	path: string;
	body?: unknown;
	init?: Omit<RequestInit, "method" | "body" | "headers"> & { headers?: Record<string, string> };
}

/**
 * One JSON round-trip through the typed client. Throws
 * ServerUnreachableError when the network fails. On 401 with a token
 * attached, the session is ended first; a 401 with an error envelope
 * (bad credentials on sign-in) and any other error status become a
 * typed ApiError. Anything else unexpected becomes an Error.
 */
export async function callApi<T>(deps: ApiDeps, options: CallOptions): Promise<T> {
	const { client, baseUrl } = await api(deps);
	const headers: Record<string, string> = { ...(options.init?.headers ?? {}) };
	if (options.body !== undefined) {
		headers["Content-Type"] = "application/json";
	}
	const token = await deps.getToken();
	const authed = token !== null && token !== "";
	if (authed) {
		headers["Authorization"] = `Bearer ${token}`;
	}
	type RawResult = { data?: unknown; error?: unknown; response: Response };
	const caller = client[options.method] as unknown as (
		path: string,
		init: unknown,
	) => Promise<RawResult>;
	let result: RawResult;
	try {
		result = await caller(options.path, { body: options.body, headers, ...(options.init ?? {}) });
	} catch {
		throw new ServerUnreachableError(baseUrl);
	}
	if (result.response.status === 401) {
		if (authed) {
			await deps.onUnauthorized();
		}
		if (isErrorEnvelope(result.error)) {
			throw new ApiError({
				code: result.error.error.code,
				message: result.error.error.message,
				requestId: result.error.error.request_id ?? "",
				status: 401,
			});
		}
		throw new SessionExpiredError();
	}
	if (result.error !== undefined) {
		if (isErrorEnvelope(result.error)) {
			throw new ApiError({
				code: result.error.error.code,
				message: result.error.error.message,
				requestId: result.error.error.request_id ?? "",
				status: result.response.status,
			});
		}
		throw new Error(`Request failed with status ${result.response.status}`);
	}
	return result.data as T;
}
