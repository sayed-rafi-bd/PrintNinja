import Papa from "papaparse";

/**
 * Batch CSV import. Replaces a hand-rolled splitter that trimmed every
 * cell (killing significant spaces inside quotes) and had no size cap.
 * Papa Parse handles quoted commas, doubled quotes and CRLF; this
 * module adds the app's guards on top.
 */

export const CSV_MAX_BYTES = 1024 * 1024;
export const CSV_MAX_ROWS = 5000;

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

export class CsvTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvTooLargeError";
  }
}

/**
 * Parses CSV text into headers + rows, preserving raw cell text
 * exactly (no trimming: `" 00123 "` keeps its spaces and zeros).
 * A leading BOM is stripped so it does not poison the first header.
 * Throws CsvTooLargeError past the byte/row caps.
 */
export function parseCsv(
  text: string,
  limits: { maxBytes?: number; maxRows?: number } = {},
): ParsedCsv {
  const maxBytes = limits.maxBytes ?? CSV_MAX_BYTES;
  const maxRows = limits.maxRows ?? CSV_MAX_ROWS;
  const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
  if (withoutBom.length === 0 || withoutBom.trim() === "") {
    return { headers: [], rows: [] };
  }
  if (new TextEncoder().encode(withoutBom).length > maxBytes) {
    throw new CsvTooLargeError(
      `CSV is over the ${(maxBytes / 1024).toFixed(0)} KiB cap`,
    );
  }
  const result = Papa.parse<string[]>(withoutBom, {
    delimiter: ",",
    skipEmptyLines: "greedy",
  });
  if (result.errors.length > 0) {
    throw new Error(`CSV parse failed: ${result.errors[0].message}`);
  }
  const lines = result.data.filter((row) => row.length > 0);
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }
  const [headers, ...rows] = lines;
  if (rows.length > maxRows) {
    throw new CsvTooLargeError(`CSV has ${rows.length} rows (max ${maxRows})`);
  }
  return { headers, rows };
}

export type ColumnMapping = Record<string, string>;

/**
 * Applies a header→variable mapping to parsed rows. Rename a header
 * by mapping it to a new key; map it to "" to drop the column.
 * Unmapped headers keep their names.
 */
export function applyColumnMapping(
  headers: string[],
  rows: string[][],
  mapping: ColumnMapping,
): Array<Record<string, string>> {
  return rows
    .filter((row) => row.some((cell) => cell !== ""))
    .map((row) => {
      const obj: Record<string, string> = {};
      headers.forEach((header, i) => {
        const key = mapping[header] ?? header;
        if (key === "") return;
        obj[key] = row[i] ?? "";
      });
      return obj;
    });
}
