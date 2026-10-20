import { z } from "zod";

// Endpoint 16: GET /v2/health — liveness and version.
export const healthResponse = z
  .object({
    status: z.literal("ok"),
    version: z.string(),
  })
  .describe("Liveness and version of the service.");

export type HealthResponse = z.infer<typeof healthResponse>;
