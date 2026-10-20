import Fastify, { type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { healthRoutes } from "./http/routes/health.js";
import { APP_VERSION } from "./version.js";

export interface BuildAppOptions {
  logger?: boolean;
}

/**
 * Build the Fastify app with plugins and routes registered. Tests call this
 * too (REFACTORING.md section 5), so nothing here may read the network or
 * the database — those arrive with the Prisma deliverable.
 */
export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "PrintNinja API", version: APP_VERSION },
    },
    // Without this, @fastify/swagger serialises the raw Zod objects into the
    // document (`def`/`shape` junk instead of JSON Schema). Spike item 1.
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  app.get(
    "/openapi.json",
    { schema: { hide: true } },
    async () => app.swagger(),
  );

  await app.register(healthRoutes);

  return app;
}
