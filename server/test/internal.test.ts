import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { fakeDeps, testConfig } from "./helpers.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

// Scheduled cleanup for deployments with no long-lived process
// (Vercel): the endpoint the scheduler calls instead of server.ts's
// in-process timer. Fakes stand in for the repositories — the purge
// functions themselves are pinned by unit tests.
describe("GET /v2/internal/cleanup", () => {
  it("answers 404 when CRON_SECRET is unset", async () => {
    app = await buildApp({ config: testConfig(), deps: fakeDeps() });
    const response = await app.inject({
      method: "GET",
      url: "/v2/internal/cleanup",
      headers: { authorization: "Bearer anything" },
    });

    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      "not_found",
    );
  });

  it("answers 401 without (or with a wrong) Bearer secret", async () => {
    app = await buildApp({
      config: testConfig({ cronSecret: "scheduled-job-secret" }),
      deps: fakeDeps(),
    });

    for (const headers of [{}, { authorization: "Bearer wrong" }]) {
      const response = await app.inject({
        method: "GET",
        url: "/v2/internal/cleanup",
        headers,
      });
      expect(response.statusCode).toBe(401);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        "unauthorized",
      );
    }
  });

  it("purges with the right secret and reports counts", async () => {
    app = await buildApp({
      config: testConfig({ cronSecret: "scheduled-job-secret" }),
      deps: fakeDeps(),
    });
    const response = await app.inject({
      method: "GET",
      url: "/v2/internal/cleanup",
      headers: { authorization: "Bearer scheduled-job-secret" },
    });

    expect(response.statusCode).toBe(200);
    // Nothing seeded in the fakes, so both purges remove zero rows —
    // what matters is the shape and that the fakes were exercised.
    expect(response.json()).toEqual({
      purged_sessions: 0,
      purged_tombstones: 0,
    });
  });
});
