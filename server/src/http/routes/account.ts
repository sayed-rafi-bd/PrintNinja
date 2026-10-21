import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { deleteSetting, putSetting } from "../../domain/settings.js";
import {
  deleteFont,
  getFontFile,
  putFont,
  putFontFile,
} from "../../domain/fonts.js";
import { FONT_MAX_BYTES } from "../../domain/fonts.js";
import { UnauthorizedError } from "../../domain/errors.js";
import type { AuthDeps } from "../../domain/ports.js";
import type {
  FontRepository,
  SettingRepository,
} from "../../domain/libraryPorts.js";
import { requireAuth } from "../plugins/auth.js";
import { errorBody } from "../schemas/error.js";
import {
  fontIdParams,
  fontSchema,
  putFontRequest,
  putSettingBody,
  settingKeyParams,
  settingSchema,
} from "../schemas/account.js";

export interface AccountRouteOptions {
  deps: AuthDeps & { settings: SettingRepository; fonts: FontRepository };
}

function toSetting(s: {
  key: string;
  value: string;
  revision: number;
  updatedAt: Date;
}) {
  return {
    key: s.key,
    value: s.value,
    revision: s.revision,
    updated_at: s.updatedAt.toISOString(),
  };
}

function toFont(f: {
  id: string;
  name: string;
  format: string;
  sizeBytes: number;
  sha256: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: f.id,
    name: f.name,
    format: f.format,
    size_bytes: f.sizeBytes,
    sha256: f.sha256,
    revision: f.revision,
    created_at: f.createdAt.toISOString(),
    updated_at: f.updatedAt.toISOString(),
  };
}

/**
 * Endpoints 27-32: account preferences and fonts. Settings only accept
 * allow-listed keys; fonts check magic bytes and size on upload and
 * serve bytes with the SHA-256 as ETag.
 */
export async function accountRoutes(
  app: FastifyInstance,
  options: AccountRouteOptions,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = options;

  // Raw font bytes ride outside JSON: parse octet-stream into a Buffer
  // here (scoped to these routes), validate shape in the domain.
  typed.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, payload, done) => {
      done(null, payload);
    },
  );

  typed.put(
    "/v2/settings/:key",
    {
      preHandler: [requireAuth(deps)],
      schema: {
        description: "Set an account preference; the key must be allow-listed.",
        params: settingKeyParams,
        body: putSettingBody,
        response: {
          200: settingSchema,
          201: settingSchema,
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
      const before = await deps.settings
        .findByKey(request.authUser.id, request.params.key)
        .catch(() => null);
      const view = await putSetting(
        { settings: deps.settings },
        request.authUser.id,
        request.params.key,
        request.body.value,
      );
      return reply.status(before ? 200 : 201).send(toSetting(view));
    },
  );

  typed.delete(
    "/v2/settings/:key",
    {
      preHandler: [requireAuth(deps)],
      schema: {
        description: "Reset an account preference.",
        params: settingKeyParams,
        response: {
          204: z.void(),
          400: errorBody,
          401: errorBody,
          403: errorBody,
        },
      },
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new UnauthorizedError();
      }
      await deleteSetting(
        { settings: deps.settings },
        request.authUser.id,
        request.params.key,
      );
      return reply.status(204).send();
    },
  );

  typed.put(
    "/v2/fonts/:id",
    {
      preHandler: [requireAuth(deps)],
      schema: {
        description: "Create or update font metadata.",
        params: fontIdParams,
        body: putFontRequest,
        response: {
          201: fontSchema,
          200: fontSchema,
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
      const result = await putFont(
        { fonts: deps.fonts },
        {
          id: request.params.id,
          name: request.body.name,
          ifRevision: request.body.if_revision,
        },
        request.authUser.id,
      );
      return reply.status(result.status).send(toFont(result.font));
    },
  );

  typed.put(
    "/v2/fonts/:id/file",
    {
      preHandler: [requireAuth(deps)],
      // Raw bytes ride outside JSON: the only envelope is the octet
      // headers, so the budget is the domain cap plus a small margin.
      // Without this the 16 KiB service default rejects every real font
      // as a framework 413 before the domain can answer 413 itself.
      bodyLimit: FONT_MAX_BYTES + 64 * 1024,
      schema: {
        description: "Upload font bytes; checked against the format and size.",
        params: fontIdParams,
        response: {
          200: fontSchema,
          400: errorBody,
          401: errorBody,
          403: errorBody,
          404: errorBody,
          413: errorBody,
        },
      },
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new UnauthorizedError();
      }
      const bytes = request.body as unknown;
      if (!(bytes instanceof Buffer)) {
        return reply.status(400).send({
          error: {
            code: "validation_failed",
            message: "Send font bytes as application/octet-stream",
            request_id: request.id,
          },
        });
      }
      const result = await putFontFile(
        { fonts: deps.fonts },
        request.params.id,
        new Uint8Array(bytes),
        request.authUser.id,
      );
      return reply.status(200).send(toFont(result));
    },
  );

  typed.get(
    "/v2/fonts/:id/file",
    {
      preHandler: [requireAuth(deps)],
      schema: {
        description: "Download font bytes; the ETag is the SHA-256.",
        params: fontIdParams,
        response: {
          200: z.void(),
          304: z.void(),
          401: errorBody,
          404: errorBody,
        },
      },
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new UnauthorizedError();
      }
      const file = await getFontFile(
        { fonts: deps.fonts },
        request.params.id,
        request.authUser.id,
      );
      const etag = `"${file.sha256}"`;
      if (request.headers["if-none-match"] === etag) {
        return reply.status(304).send();
      }
      void reply.header("ETag", etag);
      void reply.header("Content-Type", "application/octet-stream");
      // The schema declares no body (binary download); the cast keeps
      // the typed wrapper honest about sending raw bytes.
      return reply.status(200).send(Buffer.from(file.bytes) as unknown as void);
    },
  );

  typed.delete(
    "/v2/fonts/:id",
    {
      preHandler: [requireAuth(deps)],
      schema: {
        description: "Delete a font and its file.",
        params: fontIdParams,
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
      await deleteFont(
        { fonts: deps.fonts },
        request.params.id,
        request.authUser.id,
      );
      return reply.status(204).send();
    },
  );
}
