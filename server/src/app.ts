import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
	jsonSchemaTransform,
	serializerCompiler,
	validatorCompiler,
} from "fastify-type-provider-zod";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { AppDeps } from "./domain/ports.js";
import { registerErrorHandling } from "./http/plugins/errorHandler.js";
import { authRoutes } from "./http/routes/auth.js";
import { communityRoutes } from "./http/routes/community.js";
import { healthRoutes } from "./http/routes/health.js";
import { savedRoutes } from "./http/routes/saved.js";
import { syncRoutes } from "./http/routes/sync.js";
import { templateRoutes } from "./http/routes/templates.js";
import { versionRoutes } from "./http/routes/versions.js";
import { APP_VERSION } from "./version.js";

/**
 * Body limit for the whole service (D11: default caps, per-route
 * overrides where the plan sets a bigger one). Bytes.
 */
export const DEFAULT_BODY_LIMIT = 16 * 1024;

/**
 * Builds the Fastify instance: Zod validation, the OpenAPI document,
 * cross-cutting plugins, error envelope, routes. Tests call this too —
 * there is no second wiring path.
 */
export async function buildApp(args: {
	config: Config;
	deps: AppDeps;
}): Promise<FastifyInstance> {
	const { config, deps } = args;
	const app = Fastify({
		// One id per request, echoed in the x-request-id header and the
		// error envelope (D11). Generated, never trusted from the client.
		genReqId: () => randomUUID(),
		// Numeric per plan section 12, mapped onto what Fastify 5.12
		// accepts: false, or a local-proxy trust. A bare hop count is
		// deliberately NOT passed through — Fastify fails numbers closed
		// (its proxy-addr fork rejects hop counts entirely), because
		// hop-count-only trust lets a direct client spoof X-Forwarded-For
		// by sending enough hops. Any positive value therefore means "one
		// proxy on this host"; a direct client's XFF is ignored either way.
		trustProxy: config.trustProxy === 0 ? false : "loopback",
		bodyLimit: DEFAULT_BODY_LIMIT,
		logger: config.nodeEnv === "test" ? false : { level: config.logLevel },
	});

	// Setter style, not constructor options: passing the Zod compilers via
	// the constructor breaks serialization-schema building
	// ("data/required must be array"). Probed in scripts/probe.ts.
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(serializerCompiler);

	// Without this transform swagger emits Zod internals (def/shape)
	// instead of JSON Schema — proven in the spike.
	await app.register(swagger, {
		openapi: {
			openapi: "3.1.0",
			info: {
				title: "PrintNinja server",
				description:
					"Local HTTP service for the PrintNinja desktop app. All responses use the shared error envelope.",
				version: APP_VERSION,
			},
		},
		transform: jsonSchemaTransform,
	});

	await app.register(helmet, { contentSecurityPolicy: false });

	await app.register(cors, {
		// Exact-match allow-list; a Tauri window's Origin must be in the
		// list or the browser blocks the response. No wildcard.
		origin: config.corsOrigins,
		allowedHeaders: ["content-type", "authorization"],
		methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
	});

	// Global limiter; auth routes tighten this per-route. The builder's
	// return value is thrown into the error handler, so it carries a
	// plain 429 Error and the envelope + Retry-After header are built
	// there and by the plugin (plan section 9: no details on 429s).
	await app.register(rateLimit, {
		global: true,
		max: config.rateLimitMax,
		timeWindow: "1 minute",
		keyGenerator: (request) => request.ip,
		errorResponseBuilder: () => {
			const error = new Error("Too many requests") as Error & {
				statusCode: number;
			};
			error.statusCode = 429;
			return error;
		},
	});

	// Echo the request id on every response, success or failure.
	app.addHook("onSend", async (request, reply, payload) => {
		reply.header("x-request-id", request.id);
		return payload;
	});

	registerErrorHandling(app);

	if (config.docsEnabled) {
		await app.register(swaggerUi, {
			routePrefix: "/docs",
			uiConfig: { docExpansion: "none", deepLinking: false },
		});
		app.get("/openapi.json", { schema: { hide: true } }, async () =>
			app.swagger(),
		);
	}

	// The health route owns its full /v2/health path; no prefix here.
	await app.register(healthRoutes);

	await app.register(authRoutes, {
		deps,
		rateLimitMax: config.rateLimitAuthMax,
		rateLimitWindowMs: config.rateLimitAuthWindowSeconds * 1000,
	});
	await app.register(templateRoutes, { deps });
	await app.register(communityRoutes, { deps });
	await app.register(savedRoutes, { deps });
	await app.register(versionRoutes, { deps });
	await app.register(syncRoutes, { deps, byteBudget: config.syncPageBytes });

	return app;
}
