import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { fakeDeps, testConfig } from "./helpers.js";
import { putTemplate } from "../src/domain/templates/index.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * Fastify hands null (not undefined) for a missing body, so endpoints
 * that accept an empty body must take nullish schemas, not optional
 * ones — otherwise an explicit null fails validation with a 400 before
 * the domain ever runs.
 */
describe("nullish bodies", () => {
  async function seeded() {
    const deps = fakeDeps();
    const user = await deps.users.create({
      id: "11111111-1111-4111-8111-111111111111",
      handle: "Owner",
      handleKey: "owner",
      passwordHash: "fake-hash:password123",
    });
    const { token, tokenHash } = deps.tokens.generate();
    await deps.sessions.create({
      tokenHash,
      userId: user.id,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    });
    const { template } = await putTemplate(
      { templates: deps.templates },
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Label",
        pageWMm: 100,
        pageHMm: 150,
        body: "<div>x</div>",
      },
      user.id,
    );
    app = await buildApp({ config: testConfig(), deps });
    return { token, templateId: template.id };
  }

  it("restores with an explicit null body (428, not 400)", async () => {
    const { token, templateId } = await seeded();
    const response = await app!.inject({
      method: "POST",
      url: `/v2/templates/${templateId}/versions/1/restore`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: "null",
    });

    // No if_revision: the domain answers 428, which proves the null
    // body passed validation instead of failing it with a 400.
    expect(response.statusCode).toBe(428);
  });

  it("counts a use with an explicit null body", async () => {
    const { token, templateId } = await seeded();
    const response = await app!.inject({
      method: "POST",
      url: `/v2/templates/${templateId}/use`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: "null",
    });

    // The seed is private, so /use answers 404 — again past validation.
    expect(response.statusCode).toBe(404);
  });
});
