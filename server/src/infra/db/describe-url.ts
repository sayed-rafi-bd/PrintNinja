import { resolve } from "node:path";

/**
 * A log-safe description of DATABASE_URL: which database a run is about
 * to touch, without leaking credentials. User info and the query string
 * (where a token can ride along) are dropped; the auth token itself is
 * a separate variable and never appears here. A `file:` URL also shows
 * the absolute path it resolves to, because a relative one depends on
 * the directory the process was started from.
 */
export function describeDatabaseUrl(
  url: string,
  cwd: string = process.cwd(),
): string {
  const noQuery = url.split(/[?#]/, 1)[0] ?? "";

  if (noQuery.startsWith("file:")) {
    const path = noQuery.slice("file:".length).replace(/^\/\/(?=\/)/, "");
    return `${noQuery} (${resolve(cwd, path)})`;
  }

  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // Not a parseable URL: strip anything that looks like user info.
    return noQuery.replace(/\/\/[^/@]*@/, "//");
  }
}
