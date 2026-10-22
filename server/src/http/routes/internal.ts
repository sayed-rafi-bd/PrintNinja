import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { purgeExpiredSessions } from "../../domain/auth/index.js";
import { purgeOldTombstones } from "../../domain/sync/index.js";
import { NotFoundError, UnauthorizedError } from "../../domain/errors.js";
import type { AppDeps } from "../../domain/ports.js";
import { errorBody } from "../schemas/error.js";

export interface InternalRouteOptions {
  deps: Pick<AppDeps, "sessions" | "sync" | "clock">;
  /** Shared secret for scheduled cleanup. Unset disables the endpoint. */
  cronSecret?: string;
  retentionDays: number;
}

const cleanupResponse = z.object({
  purged_sessions: z.number().int(),
  purged_tombstones: z.number().int(),
});

/**
 * Scheduled maintenance for deployments with no long-lived process
 * (Vercel): one endpoint the scheduler calls instead of the in-process
 * timer in server.ts. Disabled (404) when CRON_SECRET is unset; the
 * secret travels as a Bearer token and is compared in constant time.
 */
export async function internalRoutes(
  app: FastifyInstance,
  options: InternalRouteOptions,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/v2/internal/cleanup",
    {
      schema: {
        description:
          "Scheduled cleanup: purge expired sessions and tombstones older than the retention window. Bearer CRON_SECRET; 404 when unconfigured.",
        response: { 200: cleanupResponse, 401: errorBody, 404: errorBody },
      },
    },
    async (request) => {
      const expected = options.cronSecret;
      if (!expected) {
        throw new NotFoundError();
      }
      const presented = request.headers.authorization?.startsWith("Bearer ")
        ? request.headers.authorization.slice("Bearer ".length)
        : null;
      // Hash both sides so the comparison is length-agnostic (and
      // therefore timing-agnostic): timingSafeEqual throws on
      // different-length inputs.
      const ok =
        presented !== null &&
        timingSafeEqual(
          createHash("sha256").update(presented).digest(),
          createHash("sha256").update(expected).digest(),
        );
      if (!ok) {
        throw new UnauthorizedError();
      }
      const [purgedSessions, purgedTombstones] = await Promise.all([
        purgeExpiredSessions(options.deps),
        purgeOldTombstones(options.deps, new Date(), options.retentionDays),
      ]);
      return {
        purged_sessions: purgedSessions,
        purged_tombstones: purgedTombstones,
      };
    },
  );
}
