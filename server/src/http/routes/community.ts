import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { listCommunity } from "../../domain/templates/index.js";
import type { AuthDeps } from "../../domain/ports.js";
import type {
  SavedRepository,
  TemplateRepository,
} from "../../domain/templatePorts.js";
import { toTemplateSummary } from "../mappers.js";
import { errorBody } from "../schemas/error.js";
import { communityQuery, templatePageSchema } from "../schemas/templates.js";

export interface CommunityRouteOptions {
  deps: AuthDeps & { templates: TemplateRepository; saved: SavedRepository };
}

/**
 * Endpoint 11: published templates for everyone — search, sort, pages.
 * No authentication at all (as v1): published rows carry nothing
 * private, and an invalid token is ignored rather than rejected. The
 * 429 in the contract is the global limiter; search is the expensive
 * query on this service.
 */
export async function communityRoutes(
  app: FastifyInstance,
  options: CommunityRouteOptions,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = options;

  typed.get(
    "/v2/community/templates",
    {
      schema: {
        description: "Published templates: search, sort, pages.",
        querystring: communityQuery,
        response: {
          200: templatePageSchema,
          400: errorBody,
          429: errorBody,
        },
      },
    },
    async (request) => {
      const page = await listCommunity(
        { templates: deps.templates },
        {
          page: request.query.page,
          pageSize: request.query.page_size,
          sort: request.query.sort,
          ...(request.query.q !== undefined ? { q: request.query.q } : {}),
        },
      );
      return { ...page, items: page.items.map(toTemplateSummary) };
    },
  );
}
