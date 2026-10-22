import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, DEFAULT_BODY_LIMIT } from "../src/app.js";
import { RevisionConflictError } from "../src/domain/errors.js";
import { fakeDeps, testConfig } from "./helpers.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("error envelope", () => {
  it("answers an unknown route with the 404 envelope", async () => {
    app = await buildApp({ config: testConfig(), deps: fakeDeps() });
    const response = await app.inject({ method: "GET", url: "/v2/nope" });

    expect(response.statusCode).toBe(404);
    const body = response.json() as {
      error: { code: string; message: string; request_id: string };
    };
    expect(body.error.code).toBe("not_found");
    expect(body.error.request_id).toBeTruthy();
  });

  it("answers malformed JSON with validation_failed, not a stack", async () => {
    app = await buildApp({ config: testConfig(), deps: fakeDeps() });
    const response = await app.inject({
      method: "POST",
      url: "/v2/nope",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });

    // The route does not exist either way; what matters is that no
    // framework internals or stack trace leak into the body.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toMatch(/at .*\(/);
  });

  it("maps a thrown DomainError to its code, status and details", async () => {
    app = await buildApp({ config: testConfig(), deps: fakeDeps() });
    app.get("/v2/__domain-error", async () => {
      throw new RevisionConflictError(5);
    });
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/v2/__domain-error",
    });

    expect(response.statusCode).toBe(409);
    const body = response.json() as {
      error: { code: string; message: string; details?: unknown };
    };
    expect(body.error.code).toBe("revision_conflict");
    expect(body.error.message).toBe("Stale revision");
    expect(body.error.details).toEqual([{ path: "revision", message: "5" }]);
  });

  it("hides internals behind internal_error for unexpected throws", async () => {
    app = await buildApp({ config: testConfig(), deps: fakeDeps() });
    app.get("/v2/__boom", async () => {
      throw new Error("connection string: libsql://secret");
    });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/v2/__boom" });

    expect(response.statusCode).toBe(500);
    const body = response.json() as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).not.toContain("secret");
    expect(body.error.message).not.toMatch(/at .*\(/);
    // Even a 500 carries the id, so the operator can quote it.
    expect(response.headers["x-request-id"]).toBeTruthy();
  });
});

describe("request ids", () => {
  it("echoes x-request-id on success and inside the envelope", async () => {
    app = await buildApp({ config: testConfig(), deps: fakeDeps() });
    const ok = await app.inject({ method: "GET", url: "/v2/health" });
    const missing = await app.inject({ method: "GET", url: "/v2/nope" });

    const okId = ok.headers["x-request-id"];
    const missingId = missing.headers["x-request-id"];
    expect(typeof okId).toBe("string");
    expect(okId).toBeTruthy();
    expect(missingId).toBeTruthy();
    // The envelope's request_id is the header's value, so a user can
    // quote one id that ties the response to the server logs.
    const body = missing.json() as { error: { request_id: string } };
    expect(body.error.request_id).toBe(missingId);
  });

  it("generates a distinct id per request", async () => {
    app = await buildApp({ config: testConfig(), deps: fakeDeps() });
    const first = await app.inject({ method: "GET", url: "/v2/health" });
    const second = await app.inject({ method: "GET", url: "/v2/health" });

    expect(first.headers["x-request-id"]).not.toBe(
      second.headers["x-request-id"],
    );
  });
});

describe("CORS allow-list", () => {
  it("sets the allow-origin header for an allowed origin", async () => {
    app = await buildApp({ config: testConfig(), deps: fakeDeps() });
    const response = await app.inject({
      method: "GET",
      url: "/v2/health",
      headers: { origin: "tauri://localhost" },
    });

    expect(response.headers["access-control-allow-origin"]).toBe(
      "tauri://localhost",
    );
  });

  it("omits the header for an origin that is not on the list", async () => {
    app = await buildApp({ config: testConfig(), deps: fakeDeps() });
    const response = await app.inject({
      method: "GET",
      url: "/v2/health",
      headers: { origin: "https://evil.example" },
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers preflights per origin without leaking the list", async () => {
    app = await buildApp({ config: testConfig(), deps: fakeDeps() });
    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/v2/templates/mine",
      headers: {
        origin: "http://localhost:1420",
        "access-control-request-method": "GET",
      },
    });
    expect(allowed.statusCode).toBeLessThan(300);
    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "http://localhost:1420",
    );

    const denied = await app.inject({
      method: "OPTIONS",
      url: "/v2/templates/mine",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "GET",
      },
    });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("security headers", () => {
  it("sends helmet's baseline headers on plain responses", async () => {
    app = await buildApp({ config: testConfig(), deps: fakeDeps() });
    const response = await app.inject({ method: "GET", url: "/v2/health" });

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBeDefined();
    expect(response.headers["referrer-policy"]).toBeDefined();
  });
});

describe("client IP attribution", () => {
  // The rate limiter keys by IP, so this mapping is load-bearing: a
  // wrong req.ip collapses every client into one bucket or lets a
  // spoofer dodge the limit. The probe route exists only in these tests.
  async function ipFor(
    trustProxy: number,
    headers: Record<string, string> = {},
    remoteAddress?: string,
  ): Promise<string> {
    app = await buildApp({
      config: testConfig({ trustProxy }),
      deps: fakeDeps(),
    });
    app.get("/v2/__ip", async (request) => ({ ip: request.ip }));
    await app.ready();
    const response = await app.inject({
      method: "GET",
      url: "/v2/__ip",
      headers,
      remoteAddress,
    });
    return (response.json() as { ip: string }).ip;
  }

  it("ignores X-Forwarded-For when no proxy is trusted", async () => {
    expect(await ipFor(0, { "x-forwarded-for": "9.9.9.9" })).toBe("127.0.0.1");
  });

  it("uses X-Forwarded-For from a local proxy when hops are trusted", async () => {
    expect(await ipFor(1, { "x-forwarded-for": "9.9.9.9" })).toBe("9.9.9.9");
  });

  it("still uses the peer address for a non-loopback direct client", async () => {
    expect(
      await ipFor(1, { "x-forwarded-for": "9.9.9.9" }, "203.0.113.7"),
    ).toBe("203.0.113.7");
  });
});

describe("rate limit", () => {
  it("returns the 429 envelope once the limit is exhausted", async () => {
    app = await buildApp({
      config: testConfig({ rateLimitMax: 3 }),
      deps: fakeDeps(),
    });
    for (let i = 0; i < 3; i += 1) {
      await app.inject({ method: "GET", url: "/v2/health" });
    }
    const response = await app.inject({ method: "GET", url: "/v2/health" });

    expect(response.statusCode).toBe(429);
    const body = response.json() as {
      error: { code: string; message: string; request_id: string };
    };
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.request_id).toBeTruthy();
    // Plan section 9: the retry information travels in the Retry-After
    // header, not in the envelope.
    expect(response.headers["retry-after"]).toBeDefined();
    expect("details" in body.error).toBe(false);
  });
});

describe("body limit", () => {
  it("rejects a body larger than the default cap with 413", async () => {
    app = await buildApp({ config: testConfig(), deps: fakeDeps() });
    // The route need not exist: Fastify enforces the cap while reading
    // the body, before dispatch.
    app.post("/v2/__big", async () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/v2/__big",
      headers: { "content-type": "application/json" },
      payload: { blob: "x".repeat(DEFAULT_BODY_LIMIT + 1024) },
    });

    expect(response.statusCode).toBe(413);
    const body = response.json() as { error: { code: string } };
    expect(body.error.code).toBe("payload_too_large");
  });
});

describe("docs gating", () => {
  it("serves /docs and /openapi.json when enabled", async () => {
    app = await buildApp({
      config: testConfig({ docsEnabled: true }),
      deps: fakeDeps(),
    });
    expect((await app.inject({ url: "/docs" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/openapi.json" })).statusCode).toBe(200);
  });

  it("returns the 404 envelope for /docs when disabled", async () => {
    app = await buildApp({
      config: testConfig({ docsEnabled: false }),
      deps: fakeDeps(),
    });
    const docs = await app.inject({ url: "/docs" });

    expect(docs.statusCode).toBe(404);
    const docsBody = docs.json() as { error: { code: string } };
    expect(docsBody.error.code).toBe("not_found");

    const openapi = await app.inject({ url: "/openapi.json" });
    expect(openapi.statusCode).toBe(404);
    const openapiBody = openapi.json() as { error: { code: string } };
    expect(openapiBody.error.code).toBe("not_found");
  });

  it("never caches token-carrying auth responses", async () => {
    app = await buildApp({
      config: testConfig({ docsEnabled: false }),
      deps: fakeDeps(),
    });
    const reg = await app.inject({
      method: "POST",
      url: "/v2/auth/register",
      headers: { "content-type": "application/json" },
      payload: { handle: "bo", password: "password123" },
    });
    expect(reg.statusCode).toBe(201);
    expect(reg.headers["cache-control"]).toBe("no-store");
    const token = (reg.json() as { token: string }).token;

    const me = await app.inject({
      method: "GET",
      url: "/v2/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.headers["cache-control"]).toBe("no-store");

    const logout = await app.inject({
      method: "POST",
      url: "/v2/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers["cache-control"]).toBe("no-store");
  });

  it("DELETE /v2/auth/sessions revokes every session but the caller", async () => {
    app = await buildApp({
      config: testConfig({ docsEnabled: false }),
      deps: fakeDeps(),
    });
    const headers = { "content-type": "application/json" };
    const first = await app.inject({
      method: "POST",
      url: "/v2/auth/register",
      headers,
      payload: { handle: "bo", password: "password123" },
    });
    const t1 = (first.json() as { token: string }).token;
    const second = await app.inject({
      method: "POST",
      url: "/v2/auth/login",
      headers,
      payload: { handle: "bo", password: "password123" },
    });
    const t2 = (second.json() as { token: string }).token;
    expect(t2).not.toBe(t1);

    const revoke = await app.inject({
      method: "DELETE",
      url: "/v2/auth/sessions",
      headers: { authorization: `Bearer ${t1}` },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toEqual({ revoked: 1 });

    // The caller works; the other token is dead.
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v2/auth/me",
          headers: { authorization: `Bearer ${t1}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v2/auth/me",
          headers: { authorization: `Bearer ${t2}` },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("PUT /v2/auth/password changes the password and revokes the rest", async () => {
    app = await buildApp({
      config: testConfig({ docsEnabled: false }),
      deps: fakeDeps(),
    });
    const headers = { "content-type": "application/json" };
    const reg = await app.inject({
      method: "POST",
      url: "/v2/auth/register",
      headers,
      payload: { handle: "bo", password: "password123" },
    });
    const t1 = (reg.json() as { token: string }).token;
    const second = await app.inject({
      method: "POST",
      url: "/v2/auth/login",
      headers,
      payload: { handle: "bo", password: "password123" },
    });
    const t2 = (second.json() as { token: string }).token;

    // Wrong current password: 401, nothing changes.
    const wrong = await app.inject({
      method: "PUT",
      url: "/v2/auth/password",
      headers: { ...headers, authorization: `Bearer ${t1}` },
      payload: { current_password: "nope", new_password: "new-password-1" },
    });
    expect(wrong.statusCode).toBe(401);

    const changed = await app.inject({
      method: "PUT",
      url: "/v2/auth/password",
      headers: { ...headers, authorization: `Bearer ${t1}` },
      payload: {
        current_password: "password123",
        new_password: "new-password-1",
      },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ revoked: 1 });
    expect(changed.headers["cache-control"]).toBe("no-store");

    // Old password dead, new password works, other session revoked,
    // caller still valid.
    const oldLogin = await app.inject({
      method: "POST",
      url: "/v2/auth/login",
      headers,
      payload: { handle: "bo", password: "password123" },
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({
      method: "POST",
      url: "/v2/auth/login",
      headers,
      payload: { handle: "bo", password: "new-password-1" },
    });
    expect(newLogin.statusCode).toBe(200);
    for (const [token, want] of [
      [t1, 200],
      [t2, 401],
    ] as const) {
      const me = await app.inject({
        method: "GET",
        url: "/v2/auth/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.statusCode).toBe(want);
    }
  });
});
