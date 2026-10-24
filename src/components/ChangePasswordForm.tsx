import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import * as share from "@/lib/share/client";

/**
 * Password change for the signed-in account. Validates locally first
 * (required, 8+ chars, confirmation matches); the server re-checks
 * and revokes every other session.
 */
export function ChangePasswordForm({
  busy,
  setBusy,
}: {
  busy: boolean;
  setBusy: (v: boolean) => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const { t } = useTranslation();

  const submit = async () => {
    if (!current) {
      toast.error(t("settings_page.change_password_current_required"));
      return;
    }
    if (next.length < 8) {
      toast.error(t("settings_page.change_password_too_short"));
      return;
    }
    if (next !== confirm) {
      toast.error(t("settings_page.change_password_mismatch"));
      return;
    }
    setBusy(true);
    try {
      const { revoked } = await share.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success(
        revoked > 0
          ? t("settings_page.change_password_revoked", { count: revoked })
          : t("settings_page.change_password_done"),
      );
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-sm font-medium">
        {t("settings_page.change_password_title")}
      </p>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="change-password-current">
            {t("settings_page.change_password_current")}
          </Label>
          <Input
            id="change-password-current"
            data-testid="settings-change-password-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="change-password-new">
            {t("settings_page.change_password_new")}
          </Label>
          <Input
            id="change-password-new"
            data-testid="settings-change-password-new"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="change-password-confirm">
            {t("settings_page.change_password_confirm")}
          </Label>
          <Input
            id="change-password-confirm"
            data-testid="settings-change-password-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
          />
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        data-testid="settings-change-password-submit"
        onClick={() => void submit()}
        disabled={busy}
      >
        {t("settings_page.change_password_title")}
      </Button>
      <p className="text-xs text-muted-foreground">
        {t("settings_page.change_password_hint")}
      </p>
    </div>
  );
}
