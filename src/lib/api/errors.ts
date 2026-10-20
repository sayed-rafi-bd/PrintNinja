/** Failures of the typed service client (REFACTORING.md phase 3).
 * Re-exported through share/client so existing call sites keep working. */

/** The server answered with the shared error envelope. */
export class ApiError extends Error {
	readonly code: string;
	readonly requestId: string;
	readonly status: number;

	constructor(args: { code: string; message: string; requestId: string; status: number }) {
		super(args.message);
		this.name = "ApiError";
		this.code = args.code;
		this.requestId = args.requestId;
		this.status = args.status;
	}
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
	error: { code: string; message: string; request_id?: string };
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
