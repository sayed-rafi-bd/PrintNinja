import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { describeDatabaseUrl } from "../src/infra/db/describe-url.js";

describe("describeDatabaseUrl", () => {
  it("shows a relative file URL with its resolved absolute path", () => {
    const cwd = resolve("/work/server");
    expect(describeDatabaseUrl("file:./dev.db", cwd)).toBe(
      `file:./dev.db (${resolve(cwd, "./dev.db")})`,
    );
  });

  it("keeps an absolute file URL readable", () => {
    expect(describeDatabaseUrl("file:/data/printninja.db", "/x")).toBe(
      `file:/data/printninja.db (${resolve("/data/printninja.db")})`,
    );
  });

  it("shows a libsql URL without query string or credentials", () => {
    expect(
      describeDatabaseUrl(
        "libsql://user:pw@my-db.turso.io/main?authToken=SECRET",
      ),
    ).toBe("libsql://my-db.turso.io/main");
  });

  it("never echoes a token that rides in the query of a file URL", () => {
    expect(
      describeDatabaseUrl("file:./a.db?authToken=SECRET", "/w"),
    ).not.toContain("SECRET");
  });
});
