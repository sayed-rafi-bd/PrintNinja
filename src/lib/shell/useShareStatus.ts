import { useEffect, useState } from "react";
import * as share from "@/lib/share/client";

export type ShareStatus =
  | { state: "unconfigured" }
  | { state: "signed_out" }
  | { state: "online"; handle: string }
  | { state: "offline" };

const POLL_MS = 120_000;
const TIMEOUT_MS = 4_000;

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
            const ctrl = new AbortController();
            const timer = window.setTimeout(() => ctrl.abort(), TIMEOUT_MS);
            try {
              const res = await fetch(`${url}/v1/auth/me`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: ctrl.signal,
              });
              if (res.ok) {
                const u = (await res.json()) as { handle?: string };
                next = { state: "online", handle: u.handle ?? "" };
              } else if (res.status === 401) {
                next = { state: "signed_out" };
              } else {
                next = { state: "offline" };
              }
            } catch {
              next = { state: "offline" };
            } finally {
              window.clearTimeout(timer);
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
