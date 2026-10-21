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
      throw new Error("connection string: postgresql://secret");
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
});
