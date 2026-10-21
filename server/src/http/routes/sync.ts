import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  parseCursor,
  parseTypes,
  readChanges,
} from "../../domain/sync/index.js";
import { listManifest } from "../../domain/templates/index.js";
import { UnauthorizedError } from "../../domain/errors.js";
import type { AuthDeps } from "../../domain/ports.js";
import { encodeCursor } from "../../domain/syncPorts.js";
import type {
  SavedRepository,
  TemplateRepository,
} from "../../domain/templatePorts.js";
import type { SyncRepository } from "../../domain/syncPorts.js";
import { toManifestItem, toSyncChange } from "../mappers.js";
import { requireAuth } from "../plugins/auth.js";
import { errorBody } from "../schemas/error.js";
import {
  changesResponse,
  manifestResponse,
  syncQuery,
} from "../schemas/sync.js";

export interface SyncRouteOptions {
  deps: AuthDeps & {
    templates: TemplateRepository;
    saved: SavedRepository;
    sync: SyncRepository;
  };
  byteBudget: number;
}

/**
 * Endpoint 21: everything the user owns that changed after a cursor,
 * plus deletes as tombstone records. Pages stop at the count limit or
 * the byte budget; a cursor below the tombstone floor answers
 * reset: true with a full pass from the start.
 */
export async function syncRoutes(
  app: FastifyInstance,
  options: SyncRouteOptions,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { deps, byteBudget } = options;

  typed.get(
    "/v2/sync/changes",
    {
      preHandler: [requireAuth(deps)],
      schema: {
        description: "Delta sync: changed and deleted records after a cursor.",
        querystring: syncQuery,
        response: {
          200: changesResponse,
          400: errorBody,
          401: errorBody,
        },
      },
    },
    async (request) => {
      if (!request.authUser) {
        throw new UnauthorizedError();
      }
      const result = await readChanges(
        { sync: deps.sync },
        request.authUser.id,
        {
          cursor: parseCursor(request.query.since),
          limit: request.query.limit,
          types: parseTypes(request.query.types),
        },
        byteBudget,
      );
      return {
        changes: result.changes.map(toSyncChange),
        next_cursor: encodeCursor(result.nextCursor),
        has_more: result.hasMore,
        reset: result.reset,
      };
    },
  );

  typed.get(
    "/v2/saved/manifest",
    {
      preHandler: [requireAuth(deps)],
      schema: {
        description:
          "Revision and state of every saved template, including withdrawn and deleted.",
        response: {
          200: manifestResponse,
          401: errorBody,
        },
      },
    },
    async (request) => {
      if (!request.authUser) {
        throw new UnauthorizedError();
      }
      const items = await listManifest(
        { saved: deps.saved },
        request.authUser.id,
      );
      return { items: items.map(toManifestItem) };
    },
  );
}
