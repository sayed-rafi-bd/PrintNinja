import { describe, expect, it } from "vitest";
import { Validator } from "@seriousme/openapi-schema-validator";
import { buildApp } from "../src/app.js";
import { fakeDeps, testConfig } from "./helpers.js";

type GeneratedDocument = Record<string, unknown> & {
  openapi: string;
  paths: Record<string, unknown>;
};

async function generate(): Promise<GeneratedDocument> {
  const app = await buildApp({ config: testConfig(), deps: fakeDeps() });
  await app.ready();
  const document = app.swagger() as unknown as GeneratedDocument;
  await app.close();
  return document;
}

// Phase 1 spike, assumption 1: one route, one Zod schema, and the generated
// OpenAPI 3.1 document validates against the official meta-schema.
describe("generated OpenAPI document", () => {
  it("is a valid OpenAPI 3.1 document", async () => {
    const document = await generate();

    expect(document.openapi).toMatch(/^3\.1\./);
    const validator = new Validator();
    const result = await validator.validate(document);
    expect(
      result.valid,
      result.valid ? "" : JSON.stringify(result.errors, null, 2),
    ).toBe(true);
  });

  it("emits real JSON Schema for the Zod response, not Zod internals", async () => {
    const document = await generate();

    // Regression guard for the spike finding: without jsonSchemaTransform
    // the document contained `def`/`shape` instead of properties/required.
    const health = document.paths["/v2/health"] as {
      get: {
        responses: Record<
          string,
          { content: Record<string, { schema: Record<string, unknown> }> }
        >;
      };
    };
    const schema =
      health.get.responses["200"].content["application/json"].schema;
    expect(JSON.stringify(schema)).not.toContain('"def"');
    expect(schema).toMatchObject({ type: "object" });
  });

  it("documents the health route", async () => {
    const document = await generate();
    expect(document.paths).toHaveProperty("/v2/health");
  });

  it("documents the auth endpoints with their v2 statuses", async () => {
    const document = await generate();

    const register = document.paths["/v2/auth/register"] as {
      post: { responses: Record<string, unknown> };
    };
    expect(Object.keys(register.post.responses).sort()).toEqual([
      "201",
      "400",
      "409",
      "429",
    ]);
    const login = document.paths["/v2/auth/login"] as {
      post: { responses: Record<string, unknown> };
    };
    expect(Object.keys(login.post.responses).sort()).toEqual([
      "200",
      "400",
      "401",
      "429",
    ]);
    const logout = document.paths["/v2/auth/logout"] as {
      post: { responses: Record<string, unknown> };
    };
    expect(Object.keys(logout.post.responses).sort()).toEqual([
      "204",
      "401",
      "429",
    ]);
    expect(document.paths).toHaveProperty("/v2/auth/me");
  });
});

describe("health route", () => {
  it("answers 200 with status and version", async () => {
    const app = await buildApp({ config: testConfig(), deps: fakeDeps() });
    const response = await app.inject({ method: "GET", url: "/v2/health" });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string; version: string };
    expect(body.status).toBe("ok");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("serves the raw document at /openapi.json and the UI at /docs", async () => {
    const app = await buildApp({ config: testConfig(), deps: fakeDeps() });
    const json = await app.inject({ method: "GET", url: "/openapi.json" });
    const docs = await app.inject({ method: "GET", url: "/docs" });
    await app.close();

    expect(json.statusCode).toBe(200);
    expect((json.json() as { openapi: string }).openapi).toMatch(/^3\.1\./);
    expect(docs.statusCode).toBe(200);
  });
});
