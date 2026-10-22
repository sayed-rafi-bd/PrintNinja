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

// Ported template characterization (server-legacy/src/main.rs, the B4 and
// P1 families) against the v2 service on a real database. Deliberate v2
// changes are asserted, not glossed over:
// - creates answer 201 and are always private (no publish flag);
// - updates need if_revision (428 without, 409 on stale with the stored
//   revision in details); a stale revision with identical content
//   replays 200 without writing;
// - a taken handle is 409, sizes over the field caps are 400 (over the
//   1 MiB route cap is 413), remote refs are 400 remote_reference;
// - published_at is null when private (no sentinel), created_at is absent;
// - GET carries an ETag of the revision with 304 support;
// - save is 204 and repeatable, unsave always 204, quota is 409.

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

async function register(
  handle: string,
): Promise<{ token: string; user: { id: string } }> {
  const response = await app.inject({
    method: "POST",
    url: "/v2/auth/register",
    payload: { handle, password: "password123" },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { token: string; user: { id: string } };
  return body;
}

function headers(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function put(
  id: string,
  token: string | undefined,
  body: Record<string, unknown>,
) {
  const response = await app.inject({
    method: "PUT",
    url: `/v2/templates/${id}`,
    headers: headers(token),
    payload: body,
  });
  return {
    status: response.statusCode,
    json: response.json() as Record<string, unknown>,
    response,
  };
}

const tpl = (overrides: Record<string, unknown> = {}) => ({
  name: "Label",
  summary: "",
  page_w_mm: 101.6,
  page_h_mm: 152.4,
  language: "html",
  body: "<div>x</div>",
  readme: "",
  ...overrides,
});

describe("ported B4/P1 characterization", () => {
  it("creates 201 and updates 200 with the revision", async () => {
    const { token } = await register("owner");
    const id = randomUUID();

    const created = await put(id, token, tpl());
    expect(created.status).toBe(201);
    expect(created.json["published_at"]).toBeNull();
    expect(created.json["revision"]).toBe(1);

    // No if_revision on update is a 428, not a silent overwrite.
    const noRev = await put(id, token, tpl({ body: "<div>y</div>" }));
    expect(noRev.status).toBe(428);

    const updated = await put(
      id,
      token,
      tpl({ body: "<div>y</div>", if_revision: 1 }),
    );
    expect(updated.status).toBe(200);
    expect(updated.json["revision"]).toBe(2);
    expect(updated.json["body"]).toBe("<div>y</div>");
  });

  it("refuses other owners and the anonymous", async () => {
    const a = await register("owner1");
    const b = await register("owner2");
    const id = randomUUID();
    await put(id, a.token, tpl());

    expect((await put(id, b.token, tpl({ if_revision: 1 }))).status).toBe(403);
    const del = await app.inject({
      method: "DELETE",
      url: `/v2/templates/${id}`,
      headers: headers(b.token),
    });
    expect(del.statusCode).toBe(403);
    expect((await put(id, undefined, tpl())).status).toBe(401);
  });

  it("deletes permanently and reads back 404", async () => {
    const { token } = await register("owner");
    const id = randomUUID();
    await put(id, token, tpl());

    const del = await app.inject({
      method: "DELETE",
      url: `/v2/templates/${id}`,
      headers: headers(token),
    });
    expect(del.statusCode).toBe(204);
    const got = await app.inject({
      method: "GET",
      url: `/v2/templates/${id}`,
      headers: headers(token),
    });
    expect(got.statusCode).toBe(404);
    const mine = await app.inject({
      method: "GET",
      url: "/v2/templates/mine?page_size=100",
      headers: headers(token),
    });
    expect(
      (mine.json() as { items: { id: string }[] }).items.map((t) => t.id),
    ).not.toContain(id);
  });

  it("browses published anonymously from the community list", async () => {
    const { token } = await register("owner");
    const id = randomUUID();
    await put(id, token, tpl({ name: "Public label" }));
    await app.inject({
      method: "POST",
      url: `/v2/templates/${id}/publish`,
      headers: headers(token),
    });

    const list = await app.inject({
      method: "GET",
      url: "/v2/community/templates",
    });
    expect(list.statusCode).toBe(200);
    const ids = (list.json() as { items: { id: string }[] }).items.map(
      (t) => t.id,
    );
    expect(ids).toContain(id);
  });

  it("keeps private templates visible to the owner only", async () => {
    const owner = await register("priv-owner");
    const other = await register("priv-other");
    const id = randomUUID();
    await put(id, owner.token, tpl());

    const anon = await app.inject({
      method: "GET",
      url: `/v2/templates/${id}`,
    });
    expect(anon.statusCode).toBe(404);
    const stranger = await app.inject({
      method: "GET",
      url: `/v2/templates/${id}`,
      headers: headers(other.token),
    });
    expect(stranger.statusCode).toBe(404);
    const own = await app.inject({
      method: "GET",
      url: `/v2/templates/${id}`,
      headers: headers(owner.token),
    });
    expect(own.statusCode).toBe(200);
    expect((own.json() as { body: string }).body).toBe("<div>x</div>");

    const community = await app.inject({
      method: "GET",
      url: "/v2/community/templates?page_size=100",
    });
    const ids = (community.json() as { items: { id: string }[] }).items.map(
      (t) => t.id,
    );
    expect(ids).not.toContain(id);
  });

  it("publishes, keeps the first time, hides on unpublish", async () => {
    const { token } = await register("flagger");
    const id = randomUUID();
    const created = await put(id, token, tpl());
    expect(created.json["published_at"]).toBeNull();

    const pub1 = await app.inject({
      method: "POST",
      url: `/v2/templates/${id}/publish`,
      headers: headers(token),
    });
    expect(pub1.statusCode).toBe(200);
    const first = (pub1.json() as { published_at: string }).published_at;
    expect(first).toMatch(/^\d{4}-/);

    const pub2 = await app.inject({
      method: "POST",
      url: `/v2/templates/${id}/publish`,
      headers: headers(token),
    });
    expect((pub2.json() as { published_at: string }).published_at).toBe(first);

    const community = await app.inject({
      method: "GET",
      url: "/v2/community/templates?page_size=100",
    });
    expect(
      (community.json() as { items: { id: string }[] }).items.map((t) => t.id),
    ).toContain(id);

    const unpub = await app.inject({
      method: "POST",
      url: `/v2/templates/${id}/unpublish`,
      headers: headers(token),
    });
    expect(unpub.statusCode).toBe(200);
    const after = await app.inject({
      method: "GET",
      url: "/v2/community/templates?page_size=100",
    });
    expect(
      (after.json() as { items: { id: string }[] }).items.map((t) => t.id),
    ).not.toContain(id);

    // Republishing after an unpublish restores the original time.
    const repub = await app.inject({
      method: "POST",
      url: `/v2/templates/${id}/publish`,
      headers: headers(token),
    });
    expect((repub.json() as { published_at: string }).published_at).toBe(first);
  });

  it("lists mine only for the owner and needs auth", async () => {
    const alice = await register("mine-alice");
    const bob = await register("mine-bob");
    const priv = randomUUID();
    const pub = randomUUID();
    const other = randomUUID();
    await put(priv, alice.token, tpl({ name: "AP" }));
    await put(pub, alice.token, tpl({ name: "AU" }));
    await put(other, bob.token, tpl({ name: "BU" }));
    await app.inject({
      method: "POST",
      url: `/v2/templates/${pub}/publish`,
      headers: headers(alice.token),
    });
    await app.inject({
      method: "POST",
      url: `/v2/templates/${other}/publish`,
      headers: headers(bob.token),
    });

    const anon = await app.inject({ method: "GET", url: "/v2/templates/mine" });
    expect(anon.statusCode).toBe(401);
    const mine = await app.inject({
      method: "GET",
      url: "/v2/templates/mine?page_size=100",
      headers: headers(alice.token),
    });
    const names = (mine.json() as { items: { name: string }[] }).items.map(
      (t) => t.name,
    );
    expect(names).toContain("AP");
    expect(names).toContain("AU");
    expect(names).not.toContain("BU");
  });

  it("refuses private templates for save and use, and hides unsaved ones", async () => {
    const owner = await register("sv-owner");
    const other = await register("sv-other");
    const id = randomUUID();
    await put(id, owner.token, tpl());

    const save = await app.inject({
      method: "PUT",
      url: `/v2/saved/${id}`,
      headers: headers(other.token),
    });
    expect(save.statusCode).toBe(404);
    const use = await app.inject({
      method: "POST",
      url: `/v2/templates/${id}/use`,
      headers: headers(other.token),
    });
    expect(use.statusCode).toBe(404);

    const pub = randomUUID();
    await put(pub, owner.token, tpl());
    await app.inject({
      method: "POST",
      url: `/v2/templates/${pub}/publish`,
      headers: headers(owner.token),
    });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/v2/saved/${pub}`,
          headers: headers(other.token),
        })
      ).statusCode,
    ).toBe(204);
    const saved = await app.inject({
      method: "GET",
      url: "/v2/saved?page_size=100",
      headers: headers(other.token),
    });
    expect(
      (saved.json() as { items: { id: string }[] }).items.map((t) => t.id),
    ).toContain(pub);

    await app.inject({
      method: "POST",
      url: `/v2/templates/${pub}/unpublish`,
      headers: headers(owner.token),
    });
    const after = await app.inject({
      method: "GET",
      url: "/v2/saved?page_size=100",
      headers: headers(other.token),
    });
    expect(
      (after.json() as { items: { id: string }[] }).items.map((t) => t.id),
    ).not.toContain(pub);
  });

  it("forbids visibility changes by non-owners", async () => {
    const owner = await register("vis-owner");
    const other = await register("vis-other");
    const id = randomUUID();
    await put(id, owner.token, tpl());
    await app.inject({
      method: "POST",
      url: `/v2/templates/${id}/publish`,
      headers: headers(owner.token),
    });

    const attempt = await app.inject({
      method: "POST",
      url: `/v2/templates/${id}/unpublish`,
      headers: headers(other.token),
    });
    expect(attempt.statusCode).toBe(403);
    const community = await app.inject({
      method: "GET",
      url: "/v2/community/templates?page_size=100",
    });
    expect(
      (community.json() as { items: { id: string }[] }).items.map((t) => t.id),
    ).toContain(id);
  });

  it("caps fields in bytes and the route in mebibytes", async () => {
    const { token } = await register("caps");

    const big = await put(
      randomUUID(),
      token,
      tpl({ body: "a".repeat(512 * 1024 + 1) }),
    );
    expect(big.status).toBe(413);
    expect((big.json as { error: { code: string } }).error.code).toBe(
      "payload_too_large",
    );

    const ok = await put(
      randomUUID(),
      token,
      tpl({ body: "é".repeat(256 * 1024), readme: "é".repeat(32 * 1024) }),
    );
    expect(ok.status).toBe(201);

    // Over the 1 MiB route cap is a 413, not a 400.
    const huge = await put(randomUUID(), token, {
      ...tpl(),
      body: "a".repeat(1024 * 1024 + 1),
    });
    expect(huge.status).toBe(413);
    expect((huge.json as { error: { code: string } }).error.code).toBe(
      "payload_too_large",
    );
  });

  it("round-trips css, clears it and keeps it when omitted", async () => {
    const { token } = await register("css-owner");
    const id = randomUUID();
    const css = "body { font-size: 9pt }";

    const created = await put(id, token, { ...tpl(), css });
    expect(created.status).toBe(201);
    expect(created.json["css"]).toBe(css);
    const got = await app.inject({
      method: "GET",
      url: `/v2/templates/${id}`,
      headers: headers(token),
    });
    expect((got.json() as { css: string }).css).toBe(css);

    const replaced = await put(id, token, {
      ...tpl(),
      css: ".b{}",
      if_revision: 1,
    });
    expect(replaced.json["css"]).toBe(".b{}");
    const cleared = await put(id, token, { ...tpl(), css: "", if_revision: 2 });
    expect(cleared.json["css"]).toBe("");
    const kept = await put(id, token, { ...tpl(), if_revision: 3 });
    expect(kept.json["css"]).toBe("");
  });

  it("rejects an invalid token on read with 401", async () => {
    const { token } = await register("badtok");
    const id = randomUUID();
    await put(id, token, tpl());
    await app.inject({
      method: "POST",
      url: `/v2/templates/${id}/publish`,
      headers: headers(token),
    });

    const got = await app.inject({
      method: "GET",
      url: `/v2/templates/${id}`,
      headers: headers("not-a-real-token"),
    });
    expect(got.statusCode).toBe(401);
  });
});

describe("endpoints 17-20, versions", () => {
  async function seeded() {
    const owner = await register(`vowner-${Date.now().toString(36)}`);
    const other = await register(`vother-${Date.now().toString(36)}`);
    const id = randomUUID();
    await put(id, owner.token, tpl({ body: "<div>v1</div>" }));
    await put(id, owner.token, tpl({ body: "<div>v2</div>", if_revision: 1 }));
    return { owner, other, id };
  }

  it("lists newest first, reads one, and guards ownership", async () => {
    const { owner, other, id } = await seeded();

    const list = await app.inject({
      method: "GET",
      url: `/v2/templates/${id}/versions`,
      headers: headers(owner.token),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as {
      items: { version_no: number }[];
      total: number;
    };
    expect(body.items.map((v) => v.version_no)).toEqual([2, 1]);
    expect(body.total).toBe(2);

    const one = await app.inject({
      method: "GET",
      url: `/v2/templates/${id}/versions/1`,
      headers: headers(owner.token),
    });
    expect(one.statusCode).toBe(200);
    expect((one.json() as { body: string }).body).toBe("<div>v1</div>");

    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v2/templates/${id}/versions/99`,
          headers: headers(owner.token),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v2/templates/${id}/versions/1`,
          headers: headers(other.token),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: `/v2/templates/${id}/versions` }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v2/templates/99999999-9999-4999-8999-999999999999/versions/1",
          headers: headers(owner.token),
        })
      ).statusCode,
    ).toBe(404);
  });

  it("restores as a new revision with a restore version recorded", async () => {
    const { owner, id } = await seeded();

    const restored = await app.inject({
      method: "POST",
      url: `/v2/templates/${id}/versions/1/restore`,
      headers: headers(owner.token),
      payload: { if_revision: 2 },
    });
    expect(restored.statusCode).toBe(200);
    const body = restored.json() as { revision: number; body: string };
    expect(body.revision).toBe(3);
    expect(body.body).toBe("<div>v1</div>");

    const list = await app.inject({
      method: "GET",
      url: `/v2/templates/${id}/versions`,
      headers: headers(owner.token),
    });
    const items = (
      list.json() as { items: { version_no: number; created_by: string }[] }
    ).items;
    expect(items.map((v) => v.version_no)).toEqual([3, 2, 1]);
    expect(items[0]).toMatchObject({ created_by: "restore" });

    const missing = await app.inject({
      method: "POST",
      url: `/v2/templates/${id}/versions/1/restore`,
      headers: headers(owner.token),
      payload: {},
    });
    expect(missing.statusCode).toBe(428);
    const stale = await app.inject({
      method: "POST",
      url: `/v2/templates/${id}/versions/2/restore`,
      headers: headers(owner.token),
      payload: { if_revision: 99 },
    });
    expect(stale.statusCode).toBe(409);
    expect(
      (
        stale.json() as {
          error: { details: { path: string; message: string }[] };
        }
      ).error.details,
    ).toEqual([{ path: "revision", message: "3" }]);
  });

  it("replays a restore whose content is already current", async () => {
    const { owner, id } = await seeded();

    const replay = await app.inject({
      method: "POST",
      url: `/v2/templates/${id}/versions/2/restore`,
      headers: headers(owner.token),
      payload: { if_revision: 99 },
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { revision: number }).revision).toBe(2);
    const list = await app.inject({
      method: "GET",
      url: `/v2/templates/${id}/versions`,
      headers: headers(owner.token),
    });
    expect((list.json() as { items: unknown[] }).items).toHaveLength(2);
  });

  it("refuses the newest version and deletes older ones", async () => {
    const { owner, other, id } = await seeded();

    const newest = await app.inject({
      method: "DELETE",
      url: `/v2/templates/${id}/versions/2`,
      headers: headers(owner.token),
    });
    expect(newest.statusCode).toBe(400);
    expect((newest.json() as { error: { code: string } }).error.code).toBe(
      "validation_failed",
    );

    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/v2/templates/${id}/versions/99`,
          headers: headers(owner.token),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/v2/templates/${id}/versions/1`,
          headers: headers(other.token),
        })
      ).statusCode,
    ).toBe(403);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/v2/templates/${id}/versions/1`,
      headers: headers(owner.token),
    });
    expect(deleted.statusCode).toBe(204);
    const list = await app.inject({
      method: "GET",
      url: `/v2/templates/${id}/versions`,
      headers: headers(owner.token),
    });
    expect(
      (list.json() as { items: { version_no: number }[] }).items.map(
        (v) => v.version_no,
      ),
    ).toEqual([2]);
  });
});

describe("v2 endpoint contracts", () => {
  it("conflicts carry the stored revision and replays change nothing", async () => {
    const { token } = await register("replay");
    const id = randomUUID();
    await put(id, token, tpl({ body: "<div>one</div>" }));

    const conflict = await put(
      id,
      token,
      tpl({ body: "<div>two</div>", if_revision: 99 }),
    );
    expect(conflict.status).toBe(409);
    expect(
      (
        conflict.json as {
          error: { code: string; details: { path: string; message: string }[] };
        }
      ).error,
    ).toMatchObject({
      code: "revision_conflict",
      details: [{ path: "revision", message: "1" }],
    });

    const replay = await put(
      id,
      token,
      tpl({ body: "<div>one</div>", if_revision: 99 }),
    );
    expect(replay.status).toBe(200);
    expect(replay.json["revision"]).toBe(1);
    const versions = await stack.db.templateVersion.count({
      where: { templateId: id },
    });
    expect(versions).toBe(1);
  });

  it("serves an ETag and answers 304 when it matches", async () => {
    const { token } = await register("etag");
    const id = randomUUID();
    await put(id, token, tpl());
    await app.inject({
      method: "POST",
      url: `/v2/templates/${id}/publish`,
      headers: headers(token),
    });

    const first = await app.inject({
      method: "GET",
      url: `/v2/templates/${id}`,
    });
    expect(first.statusCode).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toBe('"1"');

    const cached = await app.inject({
      method: "GET",
      url: `/v2/templates/${id}`,
      headers: { "if-none-match": etag },
    });
    expect(cached.statusCode).toBe(304);
    const changed = await app.inject({
      method: "GET",
      url: `/v2/templates/${id}`,
      headers: { "if-none-match": '"2"' },
    });
    expect(changed.statusCode).toBe(200);
  });

  it("rejects remote references with the part and the snippet", async () => {
    const { token } = await register("remoteref");
    const bad = await put(
      randomUUID(),
      token,
      tpl({ body: '<img src="http://x/y.png">' }),
    );
    expect(bad.status).toBe(400);
    const body = bad.json as {
      error: { code: string; details: { path: string; message: string }[] };
    };
    expect(body.error.code).toBe("remote_reference");
    expect(body.error.details[0]?.path).toBe("body");
  });

  it("rejects non-UUID path ids with 400", async () => {
    const { token } = await register("uuidcheck");
    for (const [method, url] of [
      ["GET", "/v2/templates/not-a-uuid"],
      ["DELETE", "/v2/templates/not-a-uuid"],
      ["POST", "/v2/templates/not-a-uuid/use"],
      ["PUT", "/v2/saved/not-a-uuid"],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: headers(token),
        payload: method === "POST" ? {} : undefined,
      });
      expect(response.statusCode, `${method} ${url}`).toBe(400);
    }
  });

  it("validates the use count body", async () => {
    const { token } = await register("usecount");
    const id = randomUUID();
    await put(id, token, tpl());
    await app.inject({
      method: "POST",
      url: `/v2/templates/${id}/publish`,
      headers: headers(token),
    });

    for (const count of [0, 101]) {
      const response = await app.inject({
        method: "POST",
        url: `/v2/templates/${id}/use`,
        headers: headers(token),
        payload: { count },
      });
      expect(response.statusCode).toBe(400);
    }
    // No body counts one.
    const bare = await app.inject({
      method: "POST",
      url: `/v2/templates/${id}/use`,
      headers: headers(token),
    });
    expect(bare.statusCode).toBe(204);
    const got = await app.inject({ method: "GET", url: `/v2/templates/${id}` });
    expect((got.json() as { use_count: number }).use_count).toBe(1);
  });

  it("adds fifty parallel uses exactly", async () => {
    const { token } = await register("parallel");
    const id = randomUUID();
    await put(id, token, tpl());
    await app.inject({
      method: "POST",
      url: `/v2/templates/${id}/publish`,
      headers: headers(token),
    });

    await Promise.all(
      Array.from({ length: 50 }, () =>
        app.inject({
          method: "POST",
          url: `/v2/templates/${id}/use`,
          headers: headers(token),
        }),
      ),
    );
    const got = await app.inject({ method: "GET", url: `/v2/templates/${id}` });
    expect((got.json() as { use_count: number }).use_count).toBe(50);
  });

  it("gives one 201 and one rejection for concurrent duplicate PUTs", async () => {
    const { token } = await register("race");
    const id = randomUUID();
    const attempts = await Promise.allSettled([
      put(id, token, tpl()),
      put(id, token, tpl()),
    ]);
    const statuses = attempts.map((result) =>
      result.status === "fulfilled" ? result.value.status : "rejected",
    );
    expect(statuses.sort()).toEqual([201, 428]);
  });

  it("gives one 200 and one 409 for concurrent same-revision updates", async () => {
    const { token } = await register("raceretry");
    const id = randomUUID();
    const created = await put(id, token, tpl());
    expect(created.status).toBe(201);

    // Both writers read revision 1; only one update can win it. The
    // bodies differ on purpose: with identical bodies a serialized run
    // would take the intentional replay-200 path instead, making the
    // outcome depend on scheduling rather than on the revision guard.
    const attempts = await Promise.allSettled([
      put(id, token, { ...tpl(), body: "<div>a</div>", if_revision: 1 }),
      put(id, token, { ...tpl(), body: "<div>b</div>", if_revision: 1 }),
    ]);
    const statuses = attempts.map((result) =>
      result.status === "fulfilled" ? result.value.status : "rejected",
    );
    expect(statuses.sort()).toEqual([200, 409]);
  });

  it("paginates, sorts and searches literally", async () => {
    const { token } = await register("pages");
    const names = ["delta", "alpha", "charlie"];
    for (const name of names) {
      const id = randomUUID();
      await put(id, token, tpl({ name }));
      await app.inject({
        method: "POST",
        url: `/v2/templates/${id}/publish`,
        headers: headers(token),
      });
    }

    const sorted = await app.inject({
      method: "GET",
      url: "/v2/community/templates?sort=name&page_size=100",
    });
    const items = (sorted.json() as { items: { name: string }[] }).items;
    expect(items.map((t) => t.name)).toEqual(["alpha", "charlie", "delta"]);

    const first = await app.inject({
      method: "GET",
      url: "/v2/community/templates?page=1&page_size=2&sort=name",
    });
    const page1 = first.json() as {
      items: unknown[];
      total: number;
      has_more: boolean;
      page: number;
      page_size: number;
    };
    expect(page1.total).toBe(3);
    expect(page1.has_more).toBe(true);
    expect(page1.items).toHaveLength(2);
    const second = await app.inject({
      method: "GET",
      url: "/v2/community/templates?page=2&page_size=2&sort=name",
    });
    expect((second.json() as { has_more: boolean }).has_more).toBe(false);

    const bad = await app.inject({
      method: "GET",
      url: "/v2/community/templates?page=0",
    });
    expect(bad.statusCode).toBe(400);
    const badSort = await app.inject({
      method: "GET",
      url: "/v2/community/templates?sort=newest",
    });
    expect(badSort.statusCode).toBe(400);
  });
});
