// The closed error-code vocabulary (plan section 9). It lives here, in
// the domain, so both the domain errors and the HTTP envelope schema
// share one list — http imports domain, never the reverse.
export const ERROR_CODES = [
	"validation_failed",
	"remote_reference",
	"payload_too_large",
	"unauthorized",
	"invalid_credentials",
	"forbidden",
	"not_found",
	"handle_taken",
	"revision_conflict",
	"revision_required",
	"quota_exceeded",
	"rate_limited",
	"internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// DomainError subclasses (REFACTORING.md section 5). Domain code throws
// these; the HTTP error handler maps the base class to the envelope.
// One code per business rule — the client never parses messages.
// Details stay in the envelope's path/message pairs: the stored
// revision on a revision_conflict rides as [{ path, message }].
export class DomainError extends Error {
	readonly code: ErrorCode;
	readonly statusCode: number;
	readonly details?: { path: string; message: string }[];

	constructor(
		code: ErrorCode,
		statusCode: number,
		message: string,
		details?: { path: string; message: string }[],
	) {
		super(message);
		this.name = this.constructor.name;
		this.code = code;
		this.statusCode = statusCode;
		this.details = details;
	}
}

/** Register or login with an unknown handle or a wrong password. The
 * same error for both, so handles cannot be probed. */
export class InvalidCredentialsError extends DomainError {
	constructor() {
		super("invalid_credentials", 401, "Invalid handle or password");
	}
}

/** Missing, unknown or expired session token. One message for all three,
 * for the same reason as above. */
export class UnauthorizedError extends DomainError {
	constructor() {
		super("unauthorized", 401, "Missing, unknown or expired token");
	}
}

/** Authenticated but not allowed (e.g. someone else's private template). */
export class ForbiddenError extends DomainError {
	constructor(message = "Not allowed") {
		super("forbidden", 403, message);
	}
}

/** Missing, or private and owned by someone else (deliberately the same). */
export class NotFoundError extends DomainError {
	constructor(message = "Not found") {
		super("not_found", 404, message);
	}
}

/** Register with a handle whose lowercase form is already taken. */
export class HandleTakenError extends DomainError {
	constructor() {
		super("handle_taken", 409, "Handle already taken");
	}
}

/** An update whose if_revision does not match the stored revision. */
export class RevisionConflictError extends DomainError {
	constructor(storedRevision: number) {
		super("revision_conflict", 409, "Stale revision", [
			{ path: "revision", message: String(storedRevision) },
		]);
	}
}

/** An update to an existing record without if_revision. */
export class RevisionRequiredError extends DomainError {
	constructor() {
		super("revision_required", 428, "Update needs if_revision");
	}
}

/** A per-user cap is reached (50 fonts, 1,000 saved templates). */
export class QuotaExceededError extends DomainError {
	constructor(message: string) {
		super("quota_exceeded", 409, message);
	}
}

/** A body over its size cap — the same 413 the route body limit uses
 * (E7), so clients treat every oversize rejection alike. Details name
 * the field and both sizes. */
export class PayloadTooLargeError extends DomainError {
	constructor(details: { path: string; message: string }[]) {
		super("payload_too_large", 413, "Body over the size cap", details);
	}
}

/** A value the transport or the domain rejects: wrong type, range or
 * shape. Details carry one path/message pair per rejected field. */
export class ValidationError extends DomainError {
	constructor(
		message: string,
		details: { path: string; message: string }[] = [],
	) {
		super("validation_failed", 400, message, details);
	}
}

/** The template body or CSS loads something from the network. Details
 * name the part and the offending snippet. */
export class RemoteReferenceError extends DomainError {
	constructor(details: { path: string; message: string }[]) {
		super(
			"remote_reference",
			400,
			"Template loads something from the network — use data: URIs",
			details,
		);
	}
}
