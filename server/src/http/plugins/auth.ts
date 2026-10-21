import type { FastifyReply, FastifyRequest } from "fastify";
import { validateSession } from "../../domain/auth/index.js";
import type { AuthDeps, UserRecord } from "../../domain/ports.js";

declare module "fastify" {
  interface FastifyRequest {
    authUser?: UserRecord;
  }
}

/**
 * Route guard for endpoints 3 and 4. Resolves the Bearer token through
 * the domain and attaches the user; missing, malformed, unknown and
 * expired tokens throw UnauthorizedError, which the error seam maps to
 * the 401 envelope. No per-route logic here — transport only.
 */
export function requireAuth(deps: AuthDeps) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const { user } = await validateSession(deps, token);
    request.authUser = user;
  };
}

/** Pulls the raw bearer token for logout, which needs the token itself
 * (to delete the session) rather than the resolved user. */
export function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * Route guard for reads that tolerate anonymity. No bearer header passes
 * through anonymous; a present-but-invalid token is a 401, as v1 does.
 * The domain treats a missing user as "published only".
 */
export function optionalAuth(deps: AuthDeps) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const header = request.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) {
      return;
    }
    const { user } = await validateSession(deps, header.slice(7));
    request.authUser = user;
  };
}
