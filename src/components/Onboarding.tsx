import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AppLogo } from "@/components/AppLogo";
import { usePrefs } from "@/lib/prefs/PrefsProvider";

interface OnboardingProps {
  /** Called when the person leaves the welcome screen, with the page to open first. */
  onComplete: (destination?: string) => void;
}

/**
 * First-run screen. It only says what an operator needs. Printer, template, API
 * and sharing setup is an admin job and lives in Settings → Setup.
 */
export function Onboarding({ onComplete }: OnboardingProps) {
  const { t } = useTranslation();
  const { appName, logo } = usePrefs();
  const steps = [
    t("auth.onboarding_step_templates"),
    t("auth.onboarding_step_print"),
    t("auth.onboarding_step_history"),
  ];
  return (
    <main className="flex min-h-dvh-safe items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-3">
          <AppLogo src={logo} className="h-10 w-10" />
          <CardTitle className="text-xl">
            {t("auth.onboarding_welcome", { appName })}
          </CardTitle>
          <p className="text-muted-foreground">{t("auth.onboarding_intro")}</p>
        </CardHeader>
        <CardContent className="space-y-5">
          <ol className="list-decimal space-y-1.5 pl-5">
            {steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button className="sm:flex-1" onClick={() => onComplete("/print")}>
              {t("auth.onboarding_start")}
            </Button>
            <Button
              variant="outline"
              className="sm:flex-1"
              onClick={() => onComplete("/settings?section=setup")}
            >
              {t("auth.onboarding_setup")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("auth.onboarding_checklist_hint")}
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
