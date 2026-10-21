import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { fakeDeps, testConfig } from "./helpers.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("route body limits", () => {
  it("rejects a dataset over its route budget with the 413 envelope", async () => {
    app = await buildApp({ config: testConfig(), deps: fakeDeps() });
    const response = await app.inject({
      method: "PUT",
      // No auth header on purpose: an oversized body fails at parse
      // time, before the auth preHandler runs.
      url: `/v2/datasets/${randomUUID()}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        name: "big",
        dataJson: "x".repeat(512 * 1024),
      }),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("payload_too_large");
  });

  it("rejects a font upload over its route budget with the 413 envelope", async () => {
    app = await buildApp({ config: testConfig(), deps: fakeDeps() });
    const response = await app.inject({
      method: "PUT",
      url: `/v2/fonts/${randomUUID()}/file`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.alloc(5 * 1024 * 1024 + 128 * 1024),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("payload_too_large");
  });

  it("rejects a template over its route budget with the 413 envelope", async () => {
    app = await buildApp({ config: testConfig(), deps: fakeDeps() });
    const response = await app.inject({
      method: "PUT",
      url: `/v2/templates/${randomUUID()}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        name: "big",
        body: "x".repeat(1400 * 1024),
        css: "",
      }),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("payload_too_large");
  });
});

describe("readiness", () => {
  it("answers 503 when no database probe is configured", async () => {
    app = await buildApp({ config: testConfig(), deps: fakeDeps() });
    const response = await app.inject({ method: "GET", url: "/v2/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("service_unavailable");
  });

  it("answers 200 when the probe succeeds", async () => {
    const deps = fakeDeps({ ping: async () => {} });
    app = await buildApp({ config: testConfig(), deps });
    const response = await app.inject({ method: "GET", url: "/v2/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
  });

  it("answers 503 when the database does not answer", async () => {
    const deps = fakeDeps({
      ping: async () => {
        throw new Error("down");
      },
    });
    app = await buildApp({ config: testConfig(), deps });
    const response = await app.inject({ method: "GET", url: "/v2/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("service_unavailable");
  });

  it("keeps /v2/health cheap and probe-free", async () => {
    app = await buildApp({ config: testConfig(), deps: fakeDeps() });
    const response = await app.inject({ method: "GET", url: "/v2/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
  });
});
