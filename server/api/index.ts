import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { FastifyInstance } from "fastify";
import { buildStack } from "../src/boot.js";

// Vercel serverless entry (the project root is `server/`, so this file
// becomes the function). No listening socket, no timers, no startup
// purges here: one stack per cold start, cached across warm
// invocations, requests forwarded straight into Fastify. Migrations
// run outside the request path (CI `db:apply`); scheduled cleanup
// goes through GET /v2/internal/cleanup instead of the in-process
// timer in src/server.ts (local/Docker entry, unchanged).
export const maxDuration = 30;

let ready: Promise<FastifyInstance> | undefined;

async function getApp(): Promise<FastifyInstance> {
  if (!ready) {
    ready = buildStack()
      .then(({ app }) => app.ready().then(() => app))
      .catch((error: unknown) => {
        ready = undefined;
        throw error;
      });
  }
  return ready;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const app = await getApp();
  app.server.emit("request", req, res);
}
