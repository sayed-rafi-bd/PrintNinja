import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
	deleteVersion,
	listVersions,
	readVersion,
	restoreVersion,
} from "../../domain/templates/index.js";
import { UnauthorizedError } from "../../domain/errors.js";
import type { AuthDeps } from "../../domain/ports.js";
import type {
	SavedRepository,
	TemplateRepository,
} from "../../domain/templatePorts.js";
import { toTemplate, toVersion, toVersionSummary } from "../mappers.js";
import { requireAuth } from "../plugins/auth.js";
import { errorBody } from "../schemas/error.js";
import {
	pageQuery,
	restoreBody,
	templateIdParams,
	templateSchema,
	versionNoParams,
	versionPageSchema,
	versionSchema,
} from "../schemas/templates.js";

export interface VersionRouteOptions {
	deps: AuthDeps & { templates: TemplateRepository; saved: SavedRepository };
}

/**
 * Endpoints 17-20: version list, read, restore and delete. Versions are
 * owner-only — even a published template's history is not public — so a
 * non-owner gets 403 where GET would give 404.
 */
export async function versionRoutes(
	app: FastifyInstance,
	options: VersionRouteOptions,
): Promise<void> {
	const typed = app.withTypeProvider<ZodTypeProvider>();
	const { deps } = options;

	const versionParams = templateIdParams.extend(versionNoParams.shape);

	typed.get(
		"/v2/templates/:id/versions",
		{
			preHandler: [requireAuth(deps)],
			schema: {
				description: "Version history, newest first.",
				params: templateIdParams,
				querystring: pageQuery,
				response: {
					200: versionPageSchema,
					400: errorBody,
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
			const page = await listVersions(
				{ templates: deps.templates },
				request.params.id,
				request.authUser.id,
				{ page: request.query.page, pageSize: request.query.page_size },
			);
			return { ...page, items: page.items.map(toVersionSummary) };
		},
	);

	typed.get(
		"/v2/templates/:id/versions/:n",
		{
			preHandler: [requireAuth(deps)],
			schema: {
				description: "One version with its body and CSS.",
				params: versionParams,
				response: {
					200: versionSchema,
					400: errorBody,
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
			const version = await readVersion(
				{ templates: deps.templates },
				request.params.id,
				request.params.n,
				request.authUser.id,
			);
			return toVersion(version);
		},
	);

	typed.post(
		"/v2/templates/:id/versions/:n/restore",
		{
			preHandler: [requireAuth(deps)],
			schema: {
				description:
					"Copy a version's body and CSS into the template as a new revision.",
				params: versionParams,
				body: restoreBody,
				response: {
					200: templateSchema,
					400: errorBody,
					401: errorBody,
					403: errorBody,
					404: errorBody,
					409: errorBody,
					428: errorBody,
				},
			},
		},
		async (request, reply) => {
			if (!request.authUser) {
				throw new UnauthorizedError();
			}
			const result = await restoreVersion(
				{ templates: deps.templates },
				request.params.id,
				request.params.n,
				request.authUser.id,
				request.body?.if_revision,
			);
			return reply.status(200).send(toTemplate(result.template));
		},
	);

	typed.delete(
		"/v2/templates/:id/versions/:n",
		{
			preHandler: [requireAuth(deps)],
			schema: {
				description: "Delete one version. The newest cannot be deleted.",
				params: versionParams,
				response: {
					204: z.null(),
					400: errorBody,
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
			await deleteVersion(
				{ templates: deps.templates },
				request.params.id,
				request.params.n,
				request.authUser.id,
			);
			return reply.status(204).send(null);
		},
	);
}
