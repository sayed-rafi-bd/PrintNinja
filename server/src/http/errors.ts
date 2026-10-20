import type { FastifyInstance } from "fastify";
import type { ErrorCode } from "./schemas/error.js";

// The code vocabulary and envelope shape live in http/schemas/error.ts
// (plan section 9); this module maps failures onto it. One code per
// business rule — the client must not have to parse messages.

/**
 * A business-rule failure that knows exactly how it should appear on
 * the wire. Domain code throws these; the HTTP layer maps them to the
 * error envelope. Never build one with a status outside 4xx/5xx.
 * Details stay in the envelope's path/message pairs — for example the
 * stored revision on a revision_conflict rides as
 * [{ path: "revision", message: "<stored>" }].
 */
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
		this.name = "DomainError";
		this.code = code;
		this.statusCode = statusCode;
		this.details = details;
	}
}

/** Framework-level errors Fastify raises before a handler runs (bad
 * JSON, oversized body, rate limit, unknown route). */
const codeForStatus = (statusCode: number): ErrorCode => {
	switch (statusCode) {
		case 400:
			return "validation_failed";
		case 401:
			return "unauthorized";
		case 403:
			return "forbidden";
		case 404:
			return "not_found";
		case 413:
			return "payload_too_large";
		case 429:
			return "rate_limited";
		default:
			return "internal_error";
	}
};

/**
 * What the error seam is prepared to receive: a real Error plus the
 * optional status code Fastify and its plugins attach. Fastify 5 types
 * the handler's error as unknown, so the seam declares this shape
 * instead of narrowing blindly at every use.
 */
export type HandlerError = Error & {
	statusCode?: unknown;
};

/**
 * The single error seam. Every failure leaves the service through here
 * so the envelope, the request id and the log line cannot drift apart.
 * Domain errors keep their code and message; anything else is logged at
 * error level and reported as a bare internal error (D11: no internals
 * leak, one shape for every failure).
 */
export function registerErrorHandling(app: FastifyInstance): void {
	app.setErrorHandler<HandlerError>((error, request, reply) => {
		const statusCode =
			typeof error.statusCode === "number" && error.statusCode >= 400
				? error.statusCode
				: 500;

		if (error instanceof DomainError) {
			request.log.info(
				{ code: error.code, details: error.details },
				"domain error",
			);
			reply.status(error.statusCode).send({
				error: {
					code: error.code,
					message: error.message,
					request_id: request.id,
					...(error.details ? { details: error.details } : {}),
				},
			});
			return;
		}

		request.log.error({ err: error }, "unhandled error");
		reply.status(statusCode).send({
			error: {
				code: codeForStatus(statusCode),
				message:
					statusCode >= 500 ? "Internal server error" : error.message,
				request_id: request.id,
			},
		});
	});

	app.setNotFoundHandler((_request, reply) => {
		reply.status(404).send({
			error: {
				code: "not_found",
				message: "Route not found",
				request_id: _request.id,
			},
		});
	});
}
