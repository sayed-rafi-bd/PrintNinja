/**
 * The app opens on the Print page, not the Designer (which is also at "/").
 *
 * This used to be an effect that called `navigate("/print")` after the router
 * had mounted at "/", so the Designer rendered for a frame before the Print
 * page replaced it: a visible flicker, most noticeable right after creating an
 * account, when the whole app mounts for the first time. Rewriting the address
 * *before* the router reads it means the Designer is never rendered at all.
 *
 * Only a bare "/" is rewritten, so a deep link (`/history`, `/template/4`) is
 * kept, and the Designer stays reachable from the sidebar afterwards because
 * this runs once, when the router is first created.
 */
export function startOnPrint(): void {
  if (window.location.pathname !== "/") return;
  // Keep any query string or hash the launcher passed along.
  const { search, hash } = window.location;
  window.history.replaceState(
    window.history.state,
    "",
    `/print${search}${hash}`,
  );
}
