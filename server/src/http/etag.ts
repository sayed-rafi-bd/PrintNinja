/**
 * Matches If-None-Match against known entity tags, tolerating what real
 * clients send: comma-separated lists, weak validators (W/), surrounding
 * quotes, and bare values. Both call sites (template revisions, font
 * SHA-256 ETags) used to implement their own subset — the font download
 * only accepted one exact quoted form, so a standards-compliant client
 * re-downloaded every time.
 */
export function etagMatches(
  header: string | string[] | undefined,
  ...candidates: string[]
): boolean {
  if (!header || candidates.length === 0) {
    return false;
  }
  const normalized = new Set(
    candidates.map((candidate) =>
      candidate.trim().replace(/^W\//, "").replace(/^"|"$/g, ""),
    ),
  );
  const entries = Array.isArray(header) ? header.join(",") : header;
  return entries.split(",").some((entry) => {
    const tag = entry.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
    return tag !== "" && normalized.has(tag);
  });
}
