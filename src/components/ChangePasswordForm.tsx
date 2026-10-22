import { useState } from "react";
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

  const submit = async () => {
    if (!current) {
      toast.error("Enter the current password");
      return;
    }
    if (next.length < 8) {
      toast.error("The new password needs at least 8 characters");
      return;
    }
    if (next !== confirm) {
      toast.error("The new passwords do not match");
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
          ? `Password changed — ${revoked} other session(s) signed out`
          : "Password changed",
      );
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-sm font-medium">Change password</p>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="change-password-current">Current password</Label>
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
          <Label htmlFor="change-password-new">New password</Label>
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
          <Label htmlFor="change-password-confirm">Confirm new</Label>
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
        Change password
      </Button>
      <p className="text-xs text-muted-foreground">
        Other signed-in devices are signed out (8+ characters).
      </p>
    </div>
  );
}
