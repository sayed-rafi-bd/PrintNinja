import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { testConfig } from "../helpers.js";
import {
  realDeps,
  startTestDatabase,
  truncateAll,
  type TestStack,
} from "./db.js";

// Endpoints 23-26 (Phase 4, deliverable 1): datasets and profiles over
// HTTP against a real database. Same revision contract as templates — 428
// without if_revision on update, 409 on stale unless the content is
// identical (replayed 200) — plus ownership checks and tombstones on
// delete (visible in the sync stream).

let stack: TestStack;
let app: FastifyInstance;

beforeAll(async () => {
  stack = await startTestDatabase();
}, 180_000);

afterAll(async () => {
  await stack?.stop();
});

beforeEach(async () => {
  await truncateAll(stack.db);
  app = await buildApp({ config: testConfig(), deps: realDeps(stack.db) });
});

afterEach(async () => {
  await app?.close();
});

async function register(handle: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v2/auth/register",
    payload: { handle, password: "password123" },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { token: string }).token;
}

function headers(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

describe("datasets", () => {
  it("creates 201, updates 200 and deletes 204 with a tombstone", async () => {
    const token = await register("Rafi");
    const id = randomUUID();

    const created = await app.inject({
      method: "PUT",
      url: `/v2/datasets/${id}`,
      headers: headers(token),
      payload: { name: "Orders", dataJson: '{"rows":[]}' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id, name: "Orders", revision: 1 });

    const updated = await app.inject({
      method: "PUT",
      url: `/v2/datasets/${id}`,
      headers: headers(token),
      payload: { name: "Orders", dataJson: '{"rows":[1]}', if_revision: 1 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ revision: 2 });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/v2/datasets/${id}`,
      headers: headers(token),
    });
    expect(deleted.statusCode).toBe(204);

    // The tombstone carries the delete into the sync stream.
    const changes = await app.inject({
      method: "GET",
      url: "/v2/sync/changes",
      headers: headers(token),
    });
    expect(changes.statusCode).toBe(200);
    const ops = (
      changes.json() as { changes: { op: string; entity: string }[] }
    ).changes;
    expect(ops).toContainEqual(
      expect.objectContaining({ op: "delete", entity: "dataset" }),
    );
  });

  it("gives one 200 and one 409 for concurrent same-revision updates", async () => {
    const token = await register("dsrace");
    const id = randomUUID();
    const created = await app.inject({
      method: "PUT",
      url: `/v2/datasets/${id}`,
      headers: headers(token),
      payload: { name: "Rows", dataJson: '{"rows":[]}' },
    });
    expect(created.statusCode).toBe(201);

    const attempts = await Promise.allSettled([
      app.inject({
        method: "PUT",
        url: `/v2/datasets/${id}`,
        headers: headers(token),
        payload: { name: "A", dataJson: '{"rows":[1]}', if_revision: 1 },
      }),
      app.inject({
        method: "PUT",
        url: `/v2/datasets/${id}`,
        headers: headers(token),
        payload: { name: "B", dataJson: '{"rows":[2]}', if_revision: 1 },
      }),
    ]);
    const statuses = attempts.map((result) =>
      result.status === "fulfilled" ? result.value.statusCode : "rejected",
    );
    expect(statuses.sort()).toEqual([200, 409]);
  });

  it("needs auth, rejects other owners and requires revisions", async () => {
    const mine = await register("Mine");
    const theirs = await register("Theirs");
    const id = randomUUID();
    await app.inject({
      method: "PUT",
      url: `/v2/datasets/${id}`,
      headers: headers(mine),
      payload: { name: "Mine", dataJson: "{}" },
    });

    const anon = await app.inject({
      method: "PUT",
      url: `/v2/datasets/${id}`,
      payload: { name: "X" },
    });
    expect(anon.statusCode).toBe(401);

    const foreign = await app.inject({
      method: "PUT",
      url: `/v2/datasets/${id}`,
      headers: headers(theirs),
      payload: { name: "X", dataJson: "{}", if_revision: 1 },
    });
    expect(foreign.statusCode).toBe(403);

    const noRevision = await app.inject({
      method: "PUT",
      url: `/v2/datasets/${id}`,
      headers: headers(mine),
      payload: { name: "X", dataJson: "{}" },
    });
    expect(noRevision.statusCode).toBe(428);

    const stale = await app.inject({
      method: "PUT",
      url: `/v2/datasets/${id}`,
      headers: headers(mine),
      payload: { name: "X", dataJson: "{}", if_revision: 99 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: expect.objectContaining({ code: "revision_conflict" }),
    });

    const missing = await app.inject({
      method: "DELETE",
      url: `/v2/datasets/${randomUUID()}`,
      headers: headers(mine),
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("profiles", () => {
  it("creates keyed by template and lowercased printer name", async () => {
    const token = await register("Rafi");
    const id = randomUUID();
    const templateId = randomUUID();
    const created = await app.inject({
      method: "PUT",
      url: `/v2/profiles/${id}`,
      headers: headers(token),
      payload: {
        template_id: templateId,
        printer_name: "E2E Label Printer",
        settings_json: '{"dark":true}',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      id,
      printer_name: "e2e label printer",
      revision: 1,
    });

    const updated = await app.inject({
      method: "PUT",
      url: `/v2/profiles/${id}`,
      headers: headers(token),
      payload: {
        template_id: templateId,
        printer_name: "E2E LABEL PRINTER",
        settings_json: '{"dark":false}',
        if_revision: 1,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      revision: 2,
      printer_name: "e2e label printer",
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/v2/profiles/${id}`,
      headers: headers(token),
    });
    expect(deleted.statusCode).toBe(204);

    const changes = await app.inject({
      method: "GET",
      url: "/v2/sync/changes",
      headers: headers(token),
    });
    const ops = (
      changes.json() as { changes: { op: string; entity: string }[] }
    ).changes;
    expect(ops).toContainEqual(
      expect.objectContaining({ op: "delete", entity: "profile" }),
    );
  });

  it("needs auth and refuses other owners", async () => {
    const mine = await register("Mine2");
    const theirs = await register("Theirs2");
    const id = randomUUID();
    const templateId = randomUUID();
    await app.inject({
      method: "PUT",
      url: `/v2/profiles/${id}`,
      headers: headers(mine),
      payload: {
        template_id: templateId,
        printer_name: "E2E",
        settings_json: "{}",
      },
    });
    const foreign = await app.inject({
      method: "PUT",
      url: `/v2/profiles/${id}`,
      headers: headers(theirs),
      payload: {
        template_id: templateId,
        printer_name: "E2E",
        settings_json: "{}",
        if_revision: 1,
      },
    });
    expect(foreign.statusCode).toBe(403);
    const anon = await app.inject({
      method: "DELETE",
      url: `/v2/profiles/${id}`,
    });
    expect(anon.statusCode).toBe(401);
  });
});
