import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  listManifest,
  listSaved,
  saveTemplate,
  unsaveTemplate,
} from "../../domain/templates/index.js";
import { UnauthorizedError } from "../../domain/errors.js";
import type { AuthDeps } from "../../domain/ports.js";
import type {
  SavedRepository,
  TemplateRepository,
} from "../../domain/templatePorts.js";
import { toManifestItem, toTemplateSummary } from "../mappers.js";
import { requireAuth } from "../plugins/auth.js";
import { errorBody } from "../schemas/error.js";
import { manifestResponse } from "../schemas/sync.js";
import {
  pageQuery,
  templateIdParams,
  templatePageSchema,
} from "../schemas/templates.js";

export interface SavedRouteOptions {
  deps: AuthDeps & { templates: TemplateRepository; saved: SavedRepository };
}

/**
 * Endpoints 13-15: the saved list, save and unsave. Saving needs a
 * published template and headroom under the per-user quota; unsaving
 * never fails, not even for unknown ids.
 */
export async function savedRoutes(
  app: FastifyInstance,
  options: SavedRouteOptions,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = options;

  typed.get(
    "/v2/saved",
    {
      preHandler: [requireAuth(deps)],
      schema: {
        description: "Saved community templates, most recently saved first.",
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
      const page = await listSaved({ saved: deps.saved }, request.authUser.id, {
        page: request.query.page,
        pageSize: request.query.page_size,
      });
      return { ...page, items: page.items.map(toTemplateSummary) };
    },
  );

  typed.put(
    "/v2/saved/:id",
    {
      preHandler: [requireAuth(deps)],
      schema: {
        description: "Save a published template. Safe to repeat.",
        params: templateIdParams,
        response: {
          204: z.null(),
          401: errorBody,
          404: errorBody,
          409: errorBody,
          429: errorBody,
        },
      },
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new UnauthorizedError();
      }
      await saveTemplate(
        { templates: deps.templates, saved: deps.saved },
        request.authUser.id,
        request.params.id,
      );
      return reply.status(204).send(null);
    },
  );

  typed.delete(
    "/v2/saved/:id",
    {
      preHandler: [requireAuth(deps)],
      schema: {
        description: "Remove from the saved list, even when it was not saved.",
        params: templateIdParams,
        response: {
          204: z.null(),
          401: errorBody,
          429: errorBody,
        },
      },
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new UnauthorizedError();
      }
      await unsaveTemplate(
        { saved: deps.saved },
        request.authUser.id,
        request.params.id,
      );
      return reply.status(204).send(null);
    },
  );

  typed.get(
    "/v2/saved/manifest",
    {
      preHandler: [requireAuth(deps)],
      schema: {
        description:
          "Revision and state of saved templates, including withdrawn and deleted. Paged like every other list.",
        querystring: pageQuery,
        response: {
          200: manifestResponse,
          400: errorBody,
          401: errorBody,
        },
      },
    },
    async (request) => {
      if (!request.authUser) {
        throw new UnauthorizedError();
      }
      const page = await listManifest(
        { saved: deps.saved },
        request.authUser.id,
        {
          page: request.query.page,
          pageSize: request.query.page_size,
        },
      );
      return { ...page, items: page.items.map(toManifestItem) };
    },
  );
}
