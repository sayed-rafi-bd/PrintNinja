import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ServerUnreachableScreen } from "@/components/ServerUnreachableScreen";
import { SignInScreen } from "@/components/SignInScreen";
import { getServiceUrl, onSessionEnded } from "@/lib/share/client";
import { checkSession, type SessionCheck } from "@/lib/share/session";

type Gate =
  | { kind: "checking" }
  | { kind: "signin"; url: string | null; expired: boolean }
  | { kind: "unreachable"; url: string; retrying: boolean }
  | { kind: "ready" };

/**
 * Sign-in gate. Nothing inside it is mounted until there is a session the
 * server accepts, and the app is hidden again whenever the session ends.
 *
 * Once the app is open the gate never blocks on the network: if the server
 * drops after sign-in, printing and local editing carry on. Only a 401 or an
 * explicit sign-out brings the sign-in screen back. The app stays mounted
 * while hidden, so edits that are not saved yet are still there after the
 * person signs in again.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [gate, setGate] = useState<Gate>({ kind: "checking" });
  const [opened, setOpened] = useState(false);

  const apply = useCallback((result: SessionCheck) => {
    if (result.state === "signed_in") {
      setGate({ kind: "ready" });
      return;
    }
    setGate(
      result.state === "unreachable"
        ? { kind: "unreachable", url: result.url, retrying: false }
        : { kind: "signin", url: result.url, expired: false },
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    void checkSession().then((result) => {
      if (!cancelled) apply(result);
    });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  // A 401 anywhere, or signing out from Settings, ends up here.
  useEffect(
    () =>
      onSessionEnded((reason) => {
        // Prefill the address that was in use, so only the password is needed.
        void getServiceUrl().then((url) =>
          setGate((g) => ({ kind: "signin", url, expired: reason === "expired" && g.kind === "ready" })),
        );
      }),
    [],
  );

  useEffect(() => {
    if (gate.kind === "ready") setOpened(true);
  }, [gate.kind]);

  const retry = async () => {
    setGate((g) => (g.kind === "unreachable" ? { ...g, retrying: true } : g));
    apply(await checkSession());
  };

  const ready = gate.kind === "ready";

  return (
    <>
      {gate.kind === "checking" && (
        <div
          role="status"
          aria-label={t("auth.checking")}
          className="flex min-h-screen items-center justify-center bg-background"
        >
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      )}

      {gate.kind === "unreachable" && (
        <ServerUnreachableScreen
          url={gate.url}
          retrying={gate.retrying}
          onRetry={() => void retry()}
          onChangeServer={() => setGate({ kind: "signin", url: gate.url, expired: false })}
        />
      )}

      {gate.kind === "signin" && (
        <SignInScreen
          initialUrl={gate.url}
          notice={gate.expired ? t("auth.session_expired") : undefined}
          onSignedIn={() => setGate({ kind: "ready" })}
        />
      )}

      {opened && <div hidden={!ready}>{children}</div>}
    </>
  );
}
