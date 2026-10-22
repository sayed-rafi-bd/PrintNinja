import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  handleKey,
  changePassword,
  loginUser,
  logoutUser,
  registerUser,
  revokeOtherSessions,
} from "../../domain/auth/index.js";
import type { AuthDeps } from "../../domain/ports.js";
import { UnauthorizedError } from "../../domain/errors.js";
import { toAuthResponse, toUserResponse } from "../mappers.js";
import { bearerToken, requireAuth } from "../plugins/auth.js";
import {
  authCredentials,
  authResponse,
  changePasswordBody,
  userSchema,
} from "../schemas/auth.js";
import { errorBody } from "../schemas/error.js";

export interface AuthRouteOptions {
  deps: AuthDeps;
  rateLimitMax: number;
  rateLimitWindowMs: number;
}

/**
 * Endpoints 1-4: register, login, logout, me.
 *
 * Register and login share one brute-force limiter (10 attempts per
 * 5 minutes by default), keyed by IP *and* handle: IP-only would let a
 * shared test runner trip over itself, handle-only would let one IP
 * spray every account. The limiter runs at preHandler so the body is
 * parsed — validation failures (400) never consume the budget.
 */
export async function authRoutes(
  app: FastifyInstance,
  options: AuthRouteOptions,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = options;

  const bruteForceLimit = {
    max: options.rateLimitMax,
    timeWindow: options.rateLimitWindowMs,
    hook: "preHandler" as const,
    keyGenerator: (request: FastifyRequest) => {
      // preHandler runs after validation, so a missing handle here
      // only happens off the documented path; it still rate-limits.
      const body = request.body as { handle?: unknown } | undefined;
      const handle = typeof body?.handle === "string" ? body.handle : "";
      return `${request.ip}:${handleKey(handle)}`;
    },
  };

  typed.post(
    "/v2/auth/register",
    {
      config: { rateLimit: bruteForceLimit },
      schema: {
        description: "Create an account and its first session.",
        body: authCredentials,
        response: {
          201: authResponse,
          400: errorBody,
          409: errorBody,
          429: errorBody,
        },
      },
    },
    async (request, reply) => {
      const result = await registerUser(deps, request.body);
      // Tokens must never sit in a cache.
      return reply
        .header("Cache-Control", "no-store")
        .status(201)
        .send(toAuthResponse(result.user, result.token, result.expiresAt));
    },
  );

  typed.post(
    "/v2/auth/login",
    {
      config: { rateLimit: bruteForceLimit },
      schema: {
        description: "Sign in and mint a fresh session.",
        body: authCredentials,
        response: {
          200: authResponse,
          400: errorBody,
          401: errorBody,
          429: errorBody,
        },
      },
    },
    async (request, reply) => {
      const result = await loginUser(deps, request.body);
      // Tokens must never sit in a cache.
      return reply
        .header("Cache-Control", "no-store")
        .send(toAuthResponse(result.user, result.token, result.expiresAt));
    },
  );

  typed.post(
    "/v2/auth/logout",
    {
      schema: {
        description:
          "End one session. Idempotent: an unknown token still answers 204.",
        response: {
          204: z.null(),
          401: errorBody,
          429: errorBody,
        },
      },
    },
    async (request, reply) => {
      await logoutUser(deps, bearerToken(request));
      // 204 drops the body on the wire; null satisfies the schema type.
      return reply.header("Cache-Control", "no-store").status(204).send(null);
    },
  );

  typed.delete(
    "/v2/auth/sessions",
    {
      preHandler: [requireAuth(deps)],
      schema: {
        description:
          "End every session except the calling one (lost device, password change).",
        response: {
          200: z.object({ revoked: z.number() }),
          401: errorBody,
          429: errorBody,
        },
      },
    },
    async (request, reply) => {
      // requireAuth ran first, so authUser is set; the throw below is
      // unreachable but keeps the handler honest.
      if (!request.authUser) {
        throw new UnauthorizedError();
      }
      const revoked = await revokeOtherSessions(
        deps,
        request.authUser.id,
        bearerToken(request),
      );
      return reply.header("Cache-Control", "no-store").send({ revoked });
    },
  );

  typed.put(
    "/v2/auth/password",
    {
      preHandler: [requireAuth(deps)],
      schema: {
        description:
          "Change the account password. The current password must verify; every other session is revoked.",
        body: changePasswordBody,
        response: {
          200: z.object({ revoked: z.number() }),
          400: errorBody,
          401: errorBody,
          429: errorBody,
        },
      },
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new UnauthorizedError();
      }
      const { revoked } = await changePassword(
        deps,
        request.authUser,
        request.body.current_password,
        request.body.new_password,
        bearerToken(request),
      );
      return reply.header("Cache-Control", "no-store").send({ revoked });
    },
  );

  typed.get(
    "/v2/auth/me",
    {
      preHandler: [requireAuth(deps)],
      schema: {
        description: "The user behind the session token.",
        response: {
          200: userSchema,
          401: errorBody,
          429: errorBody,
        },
      },
    },
    async (request, reply) => {
      // requireAuth attaches the user; the throw is unreachable but
      // keeps the handler honest without a non-null assertion.
      if (!request.authUser) {
        throw new UnauthorizedError();
      }
      // Account data must never sit in a cache.
      return reply
        .header("Cache-Control", "no-store")
        .send(toUserResponse(request.authUser));
    },
  );
}
