import { describe, expect, it } from "vitest";

// E2-E7 (REFACTORING.md section 11) over HTTP against a running
// container: `pnpm --filter server test:e2e:stack` (clean database, booted stack), then E2E_BASE_URL=... test:e2e.
// Same behaviors the integration suite pins through inject, replayed
// through the real socket, image and database file.

const baseUrl = process.env.E2E_BASE_URL;
if (!baseUrl) {
  throw new Error(
    "E2E_BASE_URL is not set — start the stack first (docker compose up -d)",
  );
}

const runId = Date.now().toString(36);
const handle = (name: string) => `${name}-${runId}`;

interface AuthBody {
  token: string;
  user: { id: string; handle: string };
}

async function request(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
) {
  // No keep-alive: each request opens a fresh connection. A pooled
  // socket goes stale across E10's service restart and would fail the
  // next test with a socket error instead of an assertion.
  const headers: Record<string, string> = { connection: "close" };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
  };
}

async function register(name: string): Promise<string> {
  const reg = await request("POST", "/v2/auth/register", undefined, {
    handle: handle(name),
    password: "password123",
  });
  expect(reg.status).toBe(201);
  return (reg.json as unknown as AuthBody).token;
}

const tpl = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  summary: "",
  page_w_mm: 101.6,
  page_h_mm: 152.4,
  language: "html",
  body: `<div>${name}</div>`,
  readme: "",
  ...extra,
});

describe("E2 save, publish, discover", () => {
  it("private create, owner-only read, publish, anonymous discover", async () => {
    const owner = await register("e2owner");
    const other = await register("e2other");
    const id = crypto.randomUUID();

    const created = await request(
      "PUT",
      `/v2/templates/${id}`,
      owner,
      tpl("E2 label"),
    );
    expect(created.status).toBe(201);

    expect((await request("GET", `/v2/templates/${id}`)).status).toBe(404);
    expect((await request("GET", `/v2/templates/${id}`, other)).status).toBe(
      404,
    );
    expect((await request("GET", `/v2/templates/${id}`, owner)).status).toBe(
      200,
    );

    const pub = await request("POST", `/v2/templates/${id}/publish`, owner);
    expect(pub.status).toBe(200);

    const anon = await request("GET", `/v2/templates/${id}`);
    expect(anon.status).toBe(200);
    const community = await request(
      "GET",
      `/v2/community/templates?q=E2+label&page_size=100`,
    );
    const ids = (community.json as { items: { id: string }[] }).items.map(
      (t) => t.id,
    );
    expect(ids).toContain(id);
  });
});

describe("E3 save and use", () => {
  it("saves a published template and counts the use for everyone", async () => {
    const owner = await register("e3owner");
    const reader = await register("e3reader");
    const id = crypto.randomUUID();
    await request("PUT", `/v2/templates/${id}`, owner, tpl("E3 label"));
    await request("POST", `/v2/templates/${id}/publish`, owner);

    expect((await request("PUT", `/v2/saved/${id}`, reader)).status).toBe(204);
    const saved = await request("GET", "/v2/saved?page_size=100", reader);
    expect(
      (saved.json as { items: { id: string }[] }).items.map((t) => t.id),
    ).toContain(id);

    expect(
      (await request("POST", `/v2/templates/${id}/use`, reader, { count: 3 }))
        .status,
    ).toBe(204);
    const got = await request("GET", `/v2/templates/${id}`);
    expect((got.json as { use_count: number }).use_count).toBe(3);
  });
});

describe("E4 withdrawal", () => {
  it("unpublish hides, use 404s, republish keeps the first time", async () => {
    const owner = await register("e4owner");
    const reader = await register("e4reader");
    const id = crypto.randomUUID();
    await request("PUT", `/v2/templates/${id}`, owner, tpl("E4 label"));
    const pub = await request("POST", `/v2/templates/${id}/publish`, owner);
    const first = (pub.json as { published_at: string }).published_at;
    await request("PUT", `/v2/saved/${id}`, reader);

    expect(
      (await request("POST", `/v2/templates/${id}/unpublish`, owner)).status,
    ).toBe(200);
    const saved = await request("GET", "/v2/saved?page_size=100", reader);
    expect(
      (saved.json as { items: { id: string }[] }).items.map((t) => t.id),
    ).not.toContain(id);
    const community = await request(
      "GET",
      "/v2/community/templates?page_size=100",
    );
    expect(
      (community.json as { items: { id: string }[] }).items.map((t) => t.id),
    ).not.toContain(id);
    expect(
      (await request("POST", `/v2/templates/${id}/use`, reader)).status,
    ).toBe(404);

    const repub = await request("POST", `/v2/templates/${id}/publish`, owner);
    expect((repub.json as { published_at: string }).published_at).toBe(first);
  });
});

describe("E5 ownership", () => {
  it("non-owners get 403 and deletes propagate to saved lists", async () => {
    const owner = await register("e5owner");
    const other = await register("e5other");
    const id = crypto.randomUUID();
    await request("PUT", `/v2/templates/${id}`, owner, tpl("E5 label"));
    await request("POST", `/v2/templates/${id}/publish`, owner);
    await request("PUT", `/v2/saved/${id}`, other);

    for (const [method, path, body] of [
      ["PUT", `/v2/templates/${id}`, tpl("E5 x", { if_revision: 1 })],
      ["DELETE", `/v2/templates/${id}`, undefined],
      ["POST", `/v2/templates/${id}/publish`, undefined],
      ["POST", `/v2/templates/${id}/unpublish`, undefined],
    ] as const) {
      expect(
        (await request(method, path, other, body)).status,
        `${method} ${path}`,
      ).toBe(403);
    }

    expect((await request("DELETE", `/v2/templates/${id}`, owner)).status).toBe(
      204,
    );
    const saved = await request("GET", "/v2/saved?page_size=100", other);
    expect(
      (saved.json as { items: { id: string }[] }).items.map((t) => t.id),
    ).not.toContain(id);
  });
});

describe("E6 update without losing data", () => {
  it("keeps omitted fields, demands revisions, conflicts stale writes", async () => {
    const owner = await register("e6owner");
    const id = crypto.randomUUID();
    await request("PUT", `/v2/templates/${id}`, owner, {
      ...tpl("E6 label"),
      summary: "kept",
      css: ".a{}",
      readme: "docs",
    });

    const noRev = await request(
      "PUT",
      `/v2/templates/${id}`,
      owner,
      tpl("E6 v2"),
    );
    expect(noRev.status).toBe(428);

    const stale = await request(
      "PUT",
      `/v2/templates/${id}`,
      owner,
      tpl("E6 v2", { if_revision: 99 }),
    );
    expect(stale.status).toBe(409);

    const updated = await request("PUT", `/v2/templates/${id}`, owner, {
      name: "E6 v2",
      page_w_mm: 101.6,
      page_h_mm: 152.4,
      body: "<div>v2</div>",
      if_revision: 1,
    });
    expect(updated.status).toBe(200);
    const body = updated.json as Record<string, unknown>;
    expect(body["summary"]).toBe("kept");
    expect(body["css"]).toBe(".a{}");
    expect(body["readme"]).toBe("docs");
    expect(body["revision"]).toBe(2);
  });
});

describe("E7 limits", () => {
  it("512 KiB plus one byte is 413 and remote refs are 400", async () => {
    const owner = await register("e7owner");

    const big = await request(
      "PUT",
      `/v2/templates/${crypto.randomUUID()}`,
      owner,
      {
        ...tpl("E7 big"),
        body: "a".repeat(512 * 1024 + 1),
      },
    );
    expect(big.status).toBe(413);
    expect((big.json as { error: { code: string } }).error.code).toBe(
      "payload_too_large",
    );

    const remote = await request(
      "PUT",
      `/v2/templates/${crypto.randomUUID()}`,
      owner,
      {
        ...tpl("E7 remote"),
        body: '<img src="https://example.com/x.png">',
      },
    );
    expect(remote.status).toBe(400);
    expect((remote.json as { error: { code: string } }).error.code).toBe(
      "remote_reference",
    );
  });
});

describe("versions round-trip", () => {
  it("lists, reads, restores and deletes over HTTP", async () => {
    const owner = await register("e8owner");
    const id = crypto.randomUUID();
    expect(
      (
        await request(
          "PUT",
          `/v2/templates/${id}`,
          owner,
          tpl("E8", { body: "<div>v1</div>" }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await request(
          "PUT",
          `/v2/templates/${id}`,
          owner,
          tpl("E8", { body: "<div>v2</div>", if_revision: 1 }),
        )
      ).status,
    ).toBe(200);

    const list = await request(
      "GET",
      `/v2/templates/${id}/versions?page_size=100`,
      owner,
    );
    expect(list.status).toBe(200);
    expect(
      (list.json as { items: { version_no: number }[] }).items.map(
        (v) => v.version_no,
      ),
    ).toEqual([2, 1]);

    const one = await request("GET", `/v2/templates/${id}/versions/1`, owner);
    expect((one.json as { body: string }).body).toBe("<div>v1</div>");

    const restored = await request(
      "POST",
      `/v2/templates/${id}/versions/1/restore`,
      owner,
      { if_revision: 2 },
    );
    expect(restored.status).toBe(200);
    expect((restored.json as { revision: number }).revision).toBe(3);

    expect(
      (await request("DELETE", `/v2/templates/${id}/versions/3`, owner)).status,
    ).toBe(400);
    expect(
      (await request("DELETE", `/v2/templates/${id}/versions/1`, owner)).status,
    ).toBe(204);
    const after = await request(
      "GET",
      `/v2/templates/${id}/versions?page_size=100`,
      owner,
    );
    expect(
      (after.json as { items: { version_no: number }[] }).items.map(
        (v) => v.version_no,
      ),
    ).toEqual([3, 2]);
  });
});
