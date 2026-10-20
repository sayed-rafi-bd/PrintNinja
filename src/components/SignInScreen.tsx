import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AppLogo } from "@/components/AppLogo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePrefs } from "@/lib/prefs/PrefsProvider";
import * as share from "@/lib/share/client";
import { normalizeServiceUrl } from "@/lib/share/session";

interface SignInScreenProps {
  /** Address saved from an earlier run, if any. */
  initialUrl: string | null;
  /** Shown above the form, for example when the session ended. */
  notice?: string;
  onSignedIn: (handle: string) => void;
}

// Same rules the server enforces on register.
const HANDLE_RE = /^[\p{L}\p{N}_-]{1,32}$/u;

/** Full-screen sign-in and register form, shown before the app when there is no valid session. */
export function SignInScreen({ initialUrl, notice, onSignedIn }: SignInScreenProps) {
  const { t } = useTranslation();
  const { appName, logo } = usePrefs();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [url, setUrl] = useState(initialUrl ?? "");
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const registering = mode === "register";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;

    const address = normalizeServiceUrl(url);
    if (!address) return setError(t("auth.server_address_invalid"));
    const name = handle.trim();
    if (!name || !password) return setError(t("auth.required"));
    if (registering) {
      if (!HANDLE_RE.test(name)) return setError(t("auth.handle_invalid"));
      if (password.length < 8) return setError(t("auth.password_short"));
    }

    setError("");
    setBusy(true);
    try {
      await share.setServiceUrl(address);
      const res = registering ? await share.register(name, password) : await share.login(name, password);
      setPassword("");
      onSignedIn(res.user.handle);
    } catch (err) {
      if (err instanceof share.ServerUnreachableError) {
        setError(t("auth.unreachable_inline", { url: err.url }));
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setBusy(false);
    }
  };

  const toggleMode = () => {
    setMode(registering ? "login" : "register");
    setError("");
  };

  return (
    <main
      data-testid="signin-form"
      className="flex min-h-screen items-center justify-center bg-background p-4"
    >
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-3">
          <AppLogo src={logo} className="h-10 w-10" />
          <h1 className="text-xl font-semibold leading-none tracking-tight">
            {registering ? t("auth.register_title") : t("auth.sign_in_title", { appName })}
          </h1>
          <CardDescription>{t("auth.sign_in_description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4" noValidate>
            {notice && (
              <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">
                {notice}
              </p>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="auth-url">{t("auth.server_address")}</Label>
              <Input
                id="auth-url"
                data-testid="auth-url"
                type="url"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                placeholder="https://printninja.example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                aria-describedby="auth-url-hint"
                disabled={busy}
              />
              <p id="auth-url-hint" className="text-xs text-muted-foreground">
                {t("auth.server_address_hint")}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="auth-handle">{t("auth.handle")}</Label>
              <Input
                id="auth-handle"
                data-testid="auth-handle"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus={!!initialUrl}
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                disabled={busy}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="auth-password">{t("auth.password")}</Label>
              <Input
                id="auth-password"
                data-testid="auth-password"
                type="password"
                autoComplete={registering ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-describedby={registering ? "auth-password-hint" : undefined}
                disabled={busy}
              />
              {registering && (
                <p id="auth-password-hint" className="text-xs text-muted-foreground">
                  {t("auth.password_hint")}
                </p>
              )}
            </div>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={busy}>
              {registering
                ? busy ? t("auth.registering") : t("auth.register")
                : busy ? t("auth.signing_in") : t("auth.sign_in")}
            </Button>
            <Button type="button" variant="link" className="w-full" onClick={toggleMode} disabled={busy}>
              {registering ? t("auth.switch_to_sign_in") : t("auth.switch_to_register")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
