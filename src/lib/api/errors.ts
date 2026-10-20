/** Failures of the typed service client (REFACTORING.md phase 3).
 * Re-exported through share/client so existing call sites keep working. */

/** The server answered with the shared error envelope. */
export class ApiError extends Error {
	readonly code: string;
	readonly requestId: string;
	readonly status: number;
	/** Machine-readable extras; a 409 carries the stored revision here. */
	readonly details: Array<{ path: string; message: string }>;

	constructor(args: {
		code: string;
		message: string;
		requestId: string;
		status: number;
		details?: Array<{ path: string; message: string }>;
	}) {
		super(args.message);
		this.name = "ApiError";
		this.code = args.code;
		this.requestId = args.requestId;
		this.status = args.status;
		this.details = args.details ?? [];
	}
}

/** The stored revision from a 409's details, if the server sent one. */
export function storedRevision(err: unknown): number | null {
	if (!(err instanceof ApiError) || err.code !== "revision_conflict") {
		return null;
	}
	const found = err.details.find((d) => d.path === "revision");
	if (!found) {
		return null;
	}
	const n = Number(found.message);
	return Number.isInteger(n) && n > 0 ? n : null;
}

/** The server could not be reached at all (network down, wrong address). */
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

/** True when a response body is the shared error envelope. */
export function isErrorEnvelope(body: unknown): body is {
	error: {
		code: string;
		message: string;
		request_id?: string;
		details?: Array<{ path: string; message: string }>;
	};
} {
	if (typeof body !== "object" || body === null) {
		return false;
	}
	const error = (body as { error?: unknown }).error;
	if (typeof error !== "object" || error === null) {
		return false;
	}
	const { code, message } = error as { code?: unknown; message?: unknown };
	return typeof code === "string" && typeof message === "string";
}
