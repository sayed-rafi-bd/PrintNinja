import { useEffect, useState } from "react";
import { ServerUnreachableError, SessionExpiredError } from "@/lib/api/errors";
import * as share from "@/lib/share/client";

export type ShareStatus =
  | { state: "unconfigured" }
  | { state: "signed_out" }
  | { state: "online"; handle: string }
  | { state: "offline" };

const POLL_MS = 120_000;

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
            try {
              const me = await share.fetchMe();
              next = { state: "online", handle: me.handle ?? "" };
            } catch (err) {
              if (err instanceof SessionExpiredError) {
                // The server no longer accepts this session: back to sign-in
                // (callApi already cleared the token through onUnauthorized).
                next = { state: "signed_out" };
              } else if (err instanceof ServerUnreachableError) {
                next = { state: "offline" };
              } else {
                next = { state: "offline" };
              }
            }
          }
        }
      } catch {
        next = { state: "unconfigured" };
      }
      if (!cancelled) setStatus(next);
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
