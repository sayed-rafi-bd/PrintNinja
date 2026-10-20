import { buildApp } from "./app.js";

// Process entry (REFACTORING.md section 5): load config, build app, listen,
// and shut down cleanly on the termination signals Fastify handles for us.
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3001);

const app = await buildApp({ logger: true });
await app.listen({ port, host });
