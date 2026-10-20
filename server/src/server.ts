import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

// Process entry (REFACTORING.md section 5): load config, build app,
// listen, and shut down cleanly — stop accepting, let in-flight
// requests finish, then exit. Fail-fast: a bad environment aborts here
// with the offending field named.
const config = loadConfig();
const app = await buildApp(config);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		app.log.info({ signal }, "shutting down");
		app
			.close()
			.then(() => process.exit(0))
			.catch((error: unknown) => {
				app.log.error({ err: error }, "error during shutdown");
				process.exit(1);
			});
	});
}

await app.listen({ port: config.port, host: config.host });
