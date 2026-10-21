import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ServiceUnavailableError } from "../../domain/errors.js";
import { healthResponse } from "../schemas/health.js";
import { errorBody } from "../schemas/error.js";
import { APP_VERSION } from "../../version.js";

export interface HealthRouteOptions {
  /**
   * Database round-trip used by /v2/ready. Omitted in unit tests that
   * run without a database — readiness then answers 503 instead of
   * claiming a probe that never ran.
   */
  ping?: () => Promise<void>;
}

export async function healthRoutes(
  app: FastifyInstance,
  options?: HealthRouteOptions,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/v2/health",
    {
      schema: {
        description: "Liveness and version.",
        response: { 200: healthResponse },
      },
    },
    async () => ({ status: "ok" as const, version: APP_VERSION }),
  );

  typed.get(
    "/v2/ready",
    {
      schema: {
        description:
          "Readiness: liveness plus a database round-trip. 503 when no probe is configured or the database does not answer.",
        response: { 200: healthResponse, 503: errorBody },
      },
    },
    async () => {
      if (!options?.ping) {
        throw new ServiceUnavailableError("No database probe is configured");
      }
      try {
        await options.ping();
      } catch {
        throw new ServiceUnavailableError("The database did not answer");
      }
      return { status: "ok" as const, version: APP_VERSION };
    },
  );
}
