import type { FastifyInstance } from "fastify";
import { DomainError } from "../../domain/errors.js";
import type { ErrorCode } from "../../domain/errors.js";

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
 * optional status code Fastify and its plugins attach, plus the
 * validation report Fastify builds for schema failures (an array of
 * Ajv-shaped { instancePath, message } items, whatever the underlying
 * validator was). Fastify 5 types the handler's error as unknown, so
 * the seam declares this shape instead of narrowing blindly at every use.
 */
export type HandlerError = Error & {
	statusCode?: unknown;
	validation?: unknown;
	validationContext?: unknown;
};

/** Maps a Fastify validation report onto the envelope's path/message
 * pairs. instancePath "/address/street" becomes "address.street"; a
 * root-level failure falls back to the context ("body", "query"). */
function validationDetails(error: HandlerError): {
	path: string;
	message: string;
}[] {
	const context =
		typeof error.validationContext === "string" &&
		error.validationContext.length > 0
			? error.validationContext
			: "request";
	const items = error.validation as {
		instancePath?: unknown;
		message?: unknown;
	}[];
	return items.map((item) => {
		const raw =
			typeof item?.instancePath === "string" ? item.instancePath : "";
		const dotted = raw.replace(/^\//, "").replace(/\//g, ".");
		return {
			path: dotted.length > 0 ? dotted : context,
			message:
				typeof item?.message === "string" && item.message.length > 0
					? item.message
					: "Invalid value",
		};
	});
}

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

		if (error.statusCode === 400 && Array.isArray(error.validation)) {
			request.log.info({ validation: error.validation }, "invalid request");
			reply.status(400).send({
				error: {
					code: "validation_failed" as const,
					message: error.message,
					details: validationDetails(error),
					request_id: request.id,
				},
			});
			return;
		}
		if (typeof error.statusCode === "number" && error.statusCode < 500) {
			request.log.info({ err: error }, "client error");
		} else {
			request.log.error({ err: error }, "unhandled error");
		}
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
