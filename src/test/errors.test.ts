import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeError, isAlreadyExists } from "@/lib/errors";
import i18n, { setLanguage } from "@/lib/i18n";

describe("describeError", () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("en");
  });
  afterEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("en");
  });

  it("keeps English output identical to the Rust wording", () => {
    expect(describeError({ NotFound: "Template 3 not found" })).toBe(
      "Template 3 not found",
    );
    expect(describeError("Select a printer first")).toBe(
      "Select a printer first",
    );
    expect(describeError({ DuplicateJob: 7 })).toBe(
      "Idempotency key already used by job 7",
    );
  });

  it("translates serialized AppError variants into Japanese", async () => {
    await setLanguage("ja");
    expect(describeError({ NotFound: "Template 3 not found" })).toBe(
      "テンプレート 3 が見つかりません",
    );
    expect(describeError({ Validation: "Printer name required" })).toBe(
      "プリンター名を入力してください",
    );
    expect(describeError({ DuplicateJob: 7 })).toContain("ジョブ 7");
  });

  it("translates plain-string errors and captures parameters", async () => {
    await setLanguage("ja");
    expect(describeError("A printer named 'Front' already exists")).toBe(
      "「Front」という名前のプリンターが既にあります",
    );
    expect(describeError("Unknown deep link action: foo")).toBe(
      "不明なディープリンク操作です: foo",
    );
    expect(describeError("Could not reach 10.0.0.5: timed out")).toBe(
      "10.0.0.5 に接続できませんでした: timed out",
    );
  });

  it("labels an unmapped variant and keeps the raw detail", async () => {
    await setLanguage("ja");
    expect(describeError({ Internal: "disk exploded" })).toBe(
      "内部エラー: disk exploded",
    );
    expect(describeError({ Database: "no such table: x" })).toBe(
      "データベースエラー: no such table: x",
    );
  });

  it("passes unknown strings and Error messages through untouched", async () => {
    await setLanguage("ja");
    expect(describeError("something new")).toBe("something new");
    expect(describeError(new Error("HTTP 502"))).toBe("HTTP 502");
    expect(describeError({ message: "boom" })).toBe("boom");
  });

  it("never prints [object Object]", () => {
    expect(describeError({ weird: 1, shape: 2 })).not.toContain(
      "[object Object]",
    );
  });

  it("detects the already-exists conflict in any shape", () => {
    expect(isAlreadyExists("A template named 'x' already exists")).toBe(true);
    expect(
      isAlreadyExists({ Validation: "A printer named 'x' already exists" }),
    ).toBe(true);
    expect(isAlreadyExists("nope")).toBe(false);
  });
});
