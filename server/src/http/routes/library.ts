import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { deleteDataset, putDataset } from "../../domain/datasets.js";
import { deleteProfile, putProfile } from "../../domain/profiles.js";
import { UnauthorizedError } from "../../domain/errors.js";
import type { AuthDeps } from "../../domain/ports.js";
import type {
  DatasetRepository,
  ProfileRepository,
} from "../../domain/libraryPorts.js";
import { requireAuth } from "../plugins/auth.js";
import { errorBody } from "../schemas/error.js";
import {
  datasetSchema,
  profileSchema,
  putDatasetRequest,
  putProfileRequest,
  uuidParams,
} from "../schemas/library.js";

export interface LibraryRouteOptions {
  deps: AuthDeps & { datasets: DatasetRepository; profiles: ProfileRepository };
}

function toDataset(d: {
  id: string;
  name: string;
  dataJson: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: d.id,
    name: d.name,
    data_json: d.dataJson,
    revision: d.revision,
    created_at: d.createdAt.toISOString(),
    updated_at: d.updatedAt.toISOString(),
  };
}

function toProfile(p: {
  id: string;
  templateId: string;
  printerName: string;
  settingsJson: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: p.id,
    template_id: p.templateId,
    printer_name: p.printerName,
    settings_json: p.settingsJson,
    revision: p.revision,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}

/**
 * Endpoints 23-26: sample datasets and printer profiles, each owned by
 * the signed-in user. Same revision contract as templates: 428 without
 * if_revision on update, 409 on stale revisions unless the content is
 * identical (replayed).
 */
export async function libraryRoutes(
  app: FastifyInstance,
  options: LibraryRouteOptions,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = options;

  typed.put(
    "/v2/datasets/:id",
    {
      preHandler: [requireAuth(deps)],
      schema: {
        description: "Create or update a sample dataset by client UUID.",
        params: uuidParams,
        body: putDatasetRequest,
        response: {
          201: datasetSchema,
          200: datasetSchema,
          400: errorBody,
          401: errorBody,
          403: errorBody,
          404: errorBody,
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
      const result = await putDataset(
        { datasets: deps.datasets },
        {
          id: request.params.id,
          name: request.body.name,
          dataJson: request.body.dataJson,
          ifRevision: request.body.if_revision,
        },
        request.authUser.id,
      );
      return reply.status(result.status).send(toDataset(result.dataset));
    },
  );

  typed.delete(
    "/v2/datasets/:id",
    {
      preHandler: [requireAuth(deps)],
      schema: {
        description: "Delete a sample dataset.",
        params: uuidParams,
        response: {
          204: z.void(),
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
      await deleteDataset(
        { datasets: deps.datasets },
        request.params.id,
        request.authUser.id,
      );
      return reply.status(204).send();
    },
  );

  typed.put(
    "/v2/profiles/:id",
    {
      preHandler: [requireAuth(deps)],
      schema: {
        description:
          "Create or update a printer profile by client UUID, keyed by template and printer name.",
        params: uuidParams,
        body: putProfileRequest,
        response: {
          201: profileSchema,
          200: profileSchema,
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
      const result = await putProfile(
        { profiles: deps.profiles },
        {
          id: request.params.id,
          templateId: request.body.template_id,
          printerName: request.body.printer_name,
          settingsJson: request.body.settings_json,
          ifRevision: request.body.if_revision,
        },
        request.authUser.id,
      );
      return reply.status(result.status).send(toProfile(result.profile));
    },
  );

  typed.delete(
    "/v2/profiles/:id",
    {
      preHandler: [requireAuth(deps)],
      schema: {
        description: "Delete a printer profile.",
        params: uuidParams,
        response: {
          204: z.void(),
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
      await deleteProfile(
        { profiles: deps.profiles },
        request.params.id,
        request.authUser.id,
      );
      return reply.status(204).send();
    },
  );
}
