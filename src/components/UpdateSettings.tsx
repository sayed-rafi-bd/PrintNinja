import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { toast } from "sonner";
import {
  checkAndInstall,
  isUpdaterSupported,
  type UpdateProgress,
} from "@/lib/updater";

/** Desktop-only in-place updates from GitHub Releases. Renders nothing
 * in web mode / on mobile, where the updater backend is unavailable. */
export function UpdateSettings({ appVersion }: { appVersion: string }) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);

  if (!isUpdaterSupported()) return null;

  const onCheck = async () => {
    setChecking(true);
    setProgress(null);
    try {
      const installed = await checkAndInstall(setProgress);
      if (installed) {
        toast.success(
          t("settings_page.update_installed", { version: installed }),
        );
      } else {
        toast.success(t("settings_page.update_uptodate"));
      }
    } catch (e) {
      toast.error(t("settings_page.update_failed", { error: String(e) }));
    } finally {
      setChecking(false);
      setProgress(null);
    }
  };

  const pct =
    progress?.total != null && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t("settings_page.updates")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {t("settings_page.update_current", {
            version: appVersion ? `v${appVersion}` : "v2.2.0",
          })}
        </p>
        <Button
          variant="outline"
          data-testid="settings-check-updates"
          disabled={checking}
          onClick={() => void onCheck()}
        >
          <Download className="h-4 w-4 mr-2" />
          {checking
            ? t("settings_page.update_checking")
            : t("settings_page.update_check")}
        </Button>
        {checking && pct !== null && (
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
