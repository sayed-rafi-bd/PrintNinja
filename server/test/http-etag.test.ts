import { describe, expect, it } from "vitest";
import { etagMatches } from "../src/http/etag.js";

describe("etagMatches", () => {
  it("matches exact, quoted, weak and bare forms", () => {
    expect(etagMatches('"abc123"', "abc123")).toBe(true);
    expect(etagMatches("abc123", '"abc123"')).toBe(true);
    expect(etagMatches('W/"abc123"', "abc123")).toBe(true);
    expect(etagMatches('"abc123"', "abc123")).toBe(true);
  });

  it("matches inside comma-separated lists and arrays", () => {
    expect(etagMatches('"old", "abc123"', "abc123")).toBe(true);
    expect(etagMatches(['"old"', "abc123"], "abc123")).toBe(true);
    expect(etagMatches("*", "abc123")).toBe(false);
  });

  it("rejects missing headers, empty entries and unknown tags", () => {
    expect(etagMatches(undefined, "abc123")).toBe(false);
    expect(etagMatches("", "abc123")).toBe(false);
    expect(etagMatches('"other"', "abc123")).toBe(false);
    expect(etagMatches('"abc123"', "other")).toBe(false);
  });
});
