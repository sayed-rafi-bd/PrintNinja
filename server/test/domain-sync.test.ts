import { describe, expect, it } from "vitest";
import {
  parseCursor,
  parseTypes,
  purgeOldTombstones,
  readChanges,
} from "../src/domain/sync/index.js";
import { ValidationError } from "../src/domain/errors.js";
import { createFakeUsers } from "./fakes/index.js";
import { createFakeTemplateRepos } from "./fakes/templates.js";
import { encodeCursor } from "../src/domain/syncPorts.js";

function setup() {
  const users = createFakeUsers();
  void users.create({
    id: "owner-1",
    handle: "Owner",
    handleKey: "owner",
    passwordHash: "x",
  });
  const library = createFakeTemplateRepos(users);
  return {
    repos: { sync: library.sync, templates: library.templates },
    store: library.store,
  };
}

const write = (id: string, name: string) => ({
  id,
  ownerId: "owner-1",
  name,
  summary: "",
  pageWMm: 101.6,
  pageHMm: 152.4,
  language: "html",
  body: `<div>${name}</div>`,
  css: "",
  readme: "",
});
const version = { createdBy: "manual" as const };

describe("readChanges", () => {
  it("reads everything from an empty cursor without reset", async () => {
    const { repos } = setup();
    await repos.templates.create(write("a1", "a"), version);
    await repos.templates.create(write("b1", "b"), version);

    const result = await readChanges(
      repos,
      "owner-1",
      { cursor: null, limit: 100, types: ["template"] },
      8 * 1024 * 1024,
    );
    expect(result.reset).toBe(false);
    expect(result.changes.map((c) => c.seq)).toEqual([2n, 3n]);
    expect(result.hasMore).toBe(false);
  });

  it("returns only newer rows for an explicit cursor", async () => {
    const { repos } = setup();
    const a = await repos.templates.create(write("a1", "a"), version);
    await repos.templates.create(write("b1", "b"), version);

    const result = await readChanges(
      repos,
      "owner-1",
      { cursor: a.changeSeq, limit: 100, types: ["template"] },
      8 * 1024 * 1024,
    );
    expect(result.changes.map((c) => c.seq)).toEqual([a.changeSeq + 1n]);
    expect(result.nextCursor).toBe(a.changeSeq + 1n);
  });

  it("resets a cursor below the tombstone floor with a full pass", async () => {
    const { repos } = setup();
    await repos.templates.create(write("a1", "a"), version);
    await repos.templates.deleteWithTombstone("a1");

    const floor = await repos.sync.tombstoneFloor("owner-1");
    expect(floor).toBeGreaterThan(0n);

    const result = await readChanges(
      repos,
      "owner-1",
      { cursor: 0n, limit: 100, types: ["template"] },
      8 * 1024 * 1024,
    );
    expect(result.reset).toBe(true);
    expect(
      result.changes.map((c) =>
        "data" in c
          ? c.entity === "setting"
            ? `upsert:setting:${c.data.key}`
            : `upsert:${c.data.id}`
          : `delete:${c.entityKey}`,
      ),
    ).toContain("delete:a1");
  });

  it("does not report more across exhausted streams that add up past the limit", async () => {
    const { repos } = setup();
    await repos.templates.create(write("a1", "a"), version);
    await repos.templates.deleteWithTombstone("a1");
    await repos.templates.create(write("b1", "b"), version);
    await repos.templates.create(write("c1", "c"), version);
    await repos.templates.deleteWithTombstone("c1");

    // Tombstone floor is the first delete's seq; starting there keeps
    // the run incremental (a lower cursor would reset and re-read).
    const floor = await repos.sync.tombstoneFloor("owner-1");
    // One live row plus one tombstone above the floor, limit 1: the old
    // merged count (2 > 1) cried hasMore with every stream exhausted.
    const first = await readChanges(
      repos,
      "owner-1",
      { cursor: floor, limit: 1, types: ["template"] },
      8 * 1024 * 1024,
    );
    expect(first.reset).toBe(false);
    expect(first.changes).toHaveLength(1);
    expect(first.hasMore).toBe(false);

    const second = await readChanges(
      repos,
      "owner-1",
      { cursor: first.nextCursor, limit: 1, types: ["template"] },
      8 * 1024 * 1024,
    );
    expect(second.changes).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.changes[0].seq).not.toBe(first.changes[0].seq);
  });

  it("parses and validates cursors and type filters", async () => {
    expect(parseCursor(undefined)).toBeNull();
    expect(parseCursor("")).toBeNull();
    expect(parseCursor(encodeCursor(42n))).toBe(42n);
    expect(() => parseCursor("not-a-cursor!!")).toThrow(ValidationError);
    expect(parseTypes(undefined)).toEqual([
      "template",
      "dataset",
      "profile",
      "setting",
      "font",
    ]);
    expect(parseTypes("template, font")).toEqual(["template", "font"]);
    expect(() => parseTypes("template,nope")).toThrow(ValidationError);
  });
});

describe("purgeOldTombstones", () => {
  it("removes only tombstones past the retention window", async () => {
    const { repos } = setup();
    await repos.templates.create(write("a1", "a"), version);
    await repos.templates.deleteWithTombstone("a1");

    expect(
      await purgeOldTombstones(repos, new Date("2026-01-01T00:00:00Z"), 90),
    ).toBe(0);
    expect(await repos.sync.tombstoneFloor("owner-1")).toBeGreaterThan(0n);
    expect(
      await purgeOldTombstones(repos, new Date("2126-01-01T00:00:00Z"), 90),
    ).toBe(1);
    expect(await repos.sync.tombstoneFloor("owner-1")).toBe(0n);
  });
});
