import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AppLogo } from "@/components/AppLogo";
import { usePrefs } from "@/lib/prefs/PrefsProvider";

const OPERATOR_STEPS = [
  "Open Print and choose a template.",
  "Choose your printer, then press Print.",
  "Find past jobs in History, and reprint from there.",
];

interface OnboardingProps {
  /** Called when the person leaves the welcome screen, with the page to open first. */
  onComplete: (destination?: string) => void;
}

/**
 * First-run screen. It only says what an operator needs. Printer, template, API
 * and sharing setup is an admin job and lives in Settings → Setup.
 */
export function Onboarding({ onComplete }: OnboardingProps) {
  const { appName, logo } = usePrefs();
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-3">
          <AppLogo src={logo} className="h-10 w-10" />
          <CardTitle className="text-xl">Welcome to {appName}</CardTitle>
          <p className="text-muted-foreground">Printing takes three steps:</p>
        </CardHeader>
        <CardContent className="space-y-5">
          <ol className="list-decimal space-y-1.5 pl-5">
            {OPERATOR_STEPS.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button className="sm:flex-1" onClick={() => onComplete("/print")}>
              Start printing
            </Button>
            <Button
              variant="outline"
              className="sm:flex-1"
              onClick={() => onComplete("/settings?section=setup")}
            >
              Set up this workstation
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Setting up a printer, templates, or sharing? The checklist in
            Settings walks through it.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
