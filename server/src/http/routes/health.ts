import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { healthResponse } from "../schemas/health.js";
import { APP_VERSION } from "../../version.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
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
}
