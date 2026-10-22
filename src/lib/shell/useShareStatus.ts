import { useEffect, useState } from "react";
import { SessionExpiredError } from "@/lib/api/errors";
import * as share from "@/lib/share/client";

export type ShareStatus =
  | { state: "unconfigured" }
  | { state: "signed_out" }
  | { state: "online"; handle: string }
  | { state: "offline" };

const POLL_MS = 120_000;
// One immediate retry before reporting offline: a single failed check
// (cold server, dropped packet, one 5xx) must not park the badge on
// "offline" until the next poll or window focus. Only a second
// consecutive failure counts.
const RETRY_MS = 5_000;

/** Connection to the share service, for the top bar. Never throws. */
export function useShareStatus(): ShareStatus {
  const [status, setStatus] = useState<ShareStatus>({ state: "unconfigured" });

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      let next: ShareStatus = { state: "unconfigured" };
      try {
        const url = await share.getServiceUrl();
        if (url) {
          const token = await share.getSessionToken();
          if (!token) {
            next = { state: "signed_out" };
          } else {
            next = (await checkOnline()) ?? next;
          }
        }
      } catch {
        next = { state: "unconfigured" };
      }
      if (!cancelled) setStatus(next);
    };

    /** Online unless the session died (signed out) or two consecutive
     * checks failed (offline). Returns null when unmounted mid-retry. */
    const checkOnline = async (): Promise<ShareStatus | null> => {
      for (let attempt = 0; ; attempt++) {
        try {
          const me = await share.fetchMe();
          return { state: "online", handle: me.handle ?? "" };
        } catch (err) {
          if (err instanceof SessionExpiredError) {
            // The server no longer accepts this session: back to sign-in
            // (callApi already cleared the token through onUnauthorized).
            return { state: "signed_out" };
          }
          if (attempt >= 1 || cancelled) {
            return { state: "offline" };
          }
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
          if (cancelled) return null;
        }
      }
    };

    void check();
    const id = window.setInterval(check, POLL_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return status;
}
