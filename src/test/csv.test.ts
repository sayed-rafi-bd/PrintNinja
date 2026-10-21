import { describe, expect, it } from "vitest";
import { applyColumnMapping, CsvTooLargeError, parseCsv } from "@/lib/csv";

describe("parseCsv", () => {
  it("keeps quoted commas and significant text verbatim", () => {
    const { headers, rows } = parseCsv('sku,name\n"a,1"," 00123 "\nplain,x');
    expect(headers).toEqual(["sku", "name"]);
    expect(rows).toEqual([
      ["a,1", " 00123 "],
      ["plain", "x"],
    ]);
  });

  it("handles doubled quotes, CRLF and blank lines", () => {
    const { headers, rows } = parseCsv(
      'a,b\r\n"He said ""hi""",2\r\n\r\n3,4\r\n',
    );
    expect(headers).toEqual(["a", "b"]);
    expect(rows).toEqual([
      ['He said "hi"', "2"],
      ["3", "4"],
    ]);
  });

  it("strips a BOM instead of poisoning the first header", () => {
    const { headers, rows } = parseCsv("﻿id,name\n1,Ada");
    expect(headers).toEqual(["id", "name"]);
    expect(rows).toEqual([["1", "Ada"]]);
  });

  it("returns empty headers for empty input", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [] });
    expect(parseCsv("   \n  ")).toEqual({ headers: [], rows: [] });
  });

  it("caps oversized files and row counts", () => {
    const big = `h\n${"x\n".repeat(6000)}`;
    expect(() => parseCsv(big, { maxRows: 5000 })).toThrow(CsvTooLargeError);
    expect(() => parseCsv("h\n1", { maxBytes: 2 })).toThrow(CsvTooLargeError);
    // Exactly at the caps is accepted.
    const { rows } = parseCsv(`h\n${"x\n".repeat(5000)}`, { maxRows: 5000 });
    expect(rows).toHaveLength(5000);
  });

  it("throws a readable error for malformed quotes", () => {
    expect(() => parseCsv('a,b\n"oops,2')).toThrow(/parse failed/i);
  });
});

describe("applyColumnMapping", () => {
  const headers = ["sku", "note"];
  const rows = [
    ["a-1", "fragile"],
    ["", ""],
  ];

  it("renames headers and skips empty rows", () => {
    expect(applyColumnMapping(headers, rows, {})).toEqual([
      { sku: "a-1", note: "fragile" },
    ]);
  });

  it("renames keys and drops columns mapped to empty", () => {
    expect(applyColumnMapping(headers, rows, { sku: "id", note: "" })).toEqual([
      { id: "a-1" },
    ]);
  });

  it("fills missing trailing cells with empty strings", () => {
    expect(applyColumnMapping(["a", "b", "c"], [["1"]], {})).toEqual([
      { a: "1", b: "", c: "" },
    ]);
  });
});
