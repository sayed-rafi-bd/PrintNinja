import { CloudOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { usePrefs } from "@/lib/prefs/PrefsProvider";

interface ServerUnreachableScreenProps {
  url: string;
  retrying: boolean;
  onRetry: () => void;
  onChangeServer: () => void;
}

/** Blocking screen for when the server cannot be reached while the app starts. */
export function ServerUnreachableScreen({
  url,
  retrying,
  onRetry,
  onChangeServer,
}: ServerUnreachableScreenProps) {
  const { t } = useTranslation();
  const { appName } = usePrefs();
  return (
    <main
      data-testid="gate-unreachable"
      className="flex min-h-dvh-safe items-center justify-center bg-background p-4"
    >
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-3">
          <CloudOff
            className="h-10 w-10 text-muted-foreground"
            aria-hidden="true"
          />
          <h1 className="text-xl font-semibold leading-none tracking-tight">
            {t("auth.unreachable_title")}
          </h1>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground">
            {t("auth.unreachable_body", { appName })}
          </p>
          <p className="break-all font-mono text-xs text-muted-foreground">
            {t("auth.unreachable_address", { url })}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button className="sm:flex-1" onClick={onRetry} disabled={retrying}>
              {retrying ? t("auth.retrying") : t("auth.retry")}
            </Button>
            <Button
              variant="outline"
              className="sm:flex-1"
              onClick={onChangeServer}
              disabled={retrying}
            >
              {t("auth.change_server")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
