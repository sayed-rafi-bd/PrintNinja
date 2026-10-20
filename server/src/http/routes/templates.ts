import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
	deleteTemplate,
	getTemplate,
	listMine,
	publishTemplate,
	putTemplate,
	recordUse,
	unpublishTemplate,
} from "../../domain/templates/index.js";
import { UnauthorizedError } from "../../domain/errors.js";
import type { AuthDeps } from "../../domain/ports.js";
import type {
	SavedRepository,
	TemplateRepository,
} from "../../domain/templatePorts.js";
import { toTemplate, toTemplateSummary } from "../mappers.js";
import { optionalAuth, requireAuth } from "../plugins/auth.js";
import { errorBody } from "../schemas/error.js";
import {
	pageQuery,
	putTemplateRequest,
	templateIdParams,
	templatePageSchema,
	templateSchema,
	useBody,
} from "../schemas/templates.js";

export interface TemplateRouteOptions {
	deps: AuthDeps & { templates: TemplateRepository; saved: SavedRepository };
}

/**
 * Endpoints 5-10 and 12: create/update, read, delete, publish,
 * unpublish, own list and use counter.
 *
 * Visibility travels only through publish/unpublish: creates are always
 * private, and PUT never changes published_at. Updates need if_revision
 * (428 without, 409 on stale); a stale revision with identical content
 * replays the stored row (200, no write). The PUT body cap is 1 MiB per
 * the plan; everything else keeps the 16 KiB service default.
 */
export async function templateRoutes(
	app: FastifyInstance,
	options: TemplateRouteOptions,
): Promise<void> {
	const typed = app.withTypeProvider<ZodTypeProvider>();
	const { deps } = options;

	typed.put(
		"/v2/templates/:id",
		{
			preHandler: [requireAuth(deps)],
			bodyLimit: 1024 * 1024,
			schema: {
				description: "Create or update a template by client UUID.",
				params: templateIdParams,
				body: putTemplateRequest,
				response: {
					201: templateSchema,
					200: templateSchema,
					400: errorBody,
					401: errorBody,
					403: errorBody,
					409: errorBody,
					413: errorBody,
					428: errorBody,
				},
			},
		},
		async (request, reply) => {
			if (!request.authUser) {
				throw new UnauthorizedError();
			}
			const result = await putTemplate(
				{ templates: deps.templates },
				{
					id: request.params.id,
					name: request.body.name,
					summary: request.body.summary,
					pageWMm: request.body.page_w_mm,
					pageHMm: request.body.page_h_mm,
					language: request.body.language,
					body: request.body.body,
					css: request.body.css,
					readme: request.body.readme,
					ifRevision: request.body.if_revision,
					version: request.body.version && {
						createdBy: request.body.version.created_by ?? "manual",
						...(request.body.version.label !== undefined
							? { label: request.body.version.label }
							: {}),
						...(request.body.version.note !== undefined
							? { note: request.body.version.note }
							: {}),
					},
				},
				request.authUser.id,
			);
			return reply.status(result.status).send(toTemplate(result.template));
		},
	);

	typed.get(
		"/v2/templates/:id",
		{
			preHandler: [optionalAuth(deps)],
			schema: {
				description:
					"One template with an ETag of its revision, or 304 when If-None-Match matches.",
				params: templateIdParams,
				response: {
					200: templateSchema,
					304: z.void(),
					401: errorBody,
					404: errorBody,
				},
			},
		},
		async (request, reply) => {
			const template = await getTemplate(
				{ templates: deps.templates },
				request.params.id,
				request.authUser?.id ?? null,
			);
			if (ifNoneMatch(request.headers["if-none-match"], template.revision)) {
				return reply.status(304).send();
			}
			reply.header("etag", `"${template.revision}"`);
			return toTemplate(template);
		},
	);

	typed.delete(
		"/v2/templates/:id",
		{
			preHandler: [requireAuth(deps)],
			schema: {
				description: "Delete a template permanently.",
				params: templateIdParams,
				response: {
					204: z.null(),
					401: errorBody,
					403: errorBody,
					404: errorBody,
				},
			},
		},
		async (request, reply) => {
			if (!request.authUser) {
				throw new UnauthorizedError();
			}
			await deleteTemplate({ templates: deps.templates }, request.params.id, request.authUser.id);
			return reply.status(204).send(null);
		},
	);

	typed.post(
		"/v2/templates/:id/publish",
		{
			preHandler: [requireAuth(deps)],
			schema: {
				description: "Make a template public, keeping the first publish time.",
				params: templateIdParams,
				response: {
					200: templateSchema,
					401: errorBody,
					403: errorBody,
					404: errorBody,
				},
			},
		},
		async (request) => {
			if (!request.authUser) {
				throw new UnauthorizedError();
			}
			const template = await publishTemplate(
				{ templates: deps.templates },
				request.params.id,
				request.authUser.id,
				new Date(),
			);
			return toTemplate(template);
		},
	);

	typed.post(
		"/v2/templates/:id/unpublish",
		{
			preHandler: [requireAuth(deps)],
			schema: {
				description: "Make a template private.",
				params: templateIdParams,
				response: {
					204: z.null(),
					401: errorBody,
					403: errorBody,
					404: errorBody,
				},
			},
		},
		async (request, reply) => {
			if (!request.authUser) {
				throw new UnauthorizedError();
			}
			await unpublishTemplate(
				{ templates: deps.templates },
				request.params.id,
				request.authUser.id,
			);
			return reply.status(204).send(null);
		},
	);

	typed.get(
		"/v2/templates/mine",
		{
			preHandler: [requireAuth(deps)],
			schema: {
				description: "The signed-in user's own templates, newest first.",
				querystring: pageQuery,
				response: {
					200: templatePageSchema,
					400: errorBody,
					401: errorBody,
					429: errorBody,
				},
			},
		},
		async (request) => {
			if (!request.authUser) {
				throw new UnauthorizedError();
			}
			const page = await listMine(
				{ templates: deps.templates },
				request.authUser.id,
				{ page: request.query.page, pageSize: request.query.page_size },
			);
			return { ...page, items: page.items.map(toTemplateSummary) };
		},
	);

	typed.post(
		"/v2/templates/:id/use",
		{
			preHandler: [requireAuth(deps)],
			schema: {
				description: "Count prints of a published template.",
				params: templateIdParams,
				// A missing body counts one: Fastify hands null (not
				// undefined) for an unparsable body, so the schema takes
				// nullish, not optional.
				body: useBody.nullish(),
				response: {
					204: z.null(),
					400: errorBody,
					401: errorBody,
					404: errorBody,
					429: errorBody,
				},
			},
		},
		async (request, reply) => {
			if (!request.authUser) {
				throw new UnauthorizedError();
			}
			await recordUse(
				{ templates: deps.templates },
				request.params.id,
				request.body?.count ?? 1,
			);
			return reply.status(204).send(null);
		},
	);
}

/** Matches If-None-Match against the revision, tolerating lists,
 * weak validators and bare numbers. */
function ifNoneMatch(header: string | string[] | undefined, revision: number): boolean {
	if (!header) {
		return false;
	}
	const targets = (Array.isArray(header) ? header.join(",") : header).split(",");
	return targets.some((entry) => {
		const tag = entry.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
		return tag === String(revision);
	});
}
