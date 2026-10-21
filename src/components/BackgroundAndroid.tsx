import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { isAndroid } from "@/lib/android/background";

/** Android-only background controls. Desktop uses tray settings
 * instead (rendered beside this, never together). */
export function isAndroidBackground(): boolean {
  return isAndroid();
}

interface AndroidBackgroundControlsProps {
  running: boolean | null;
  exempt: boolean | null;
  busy: boolean;
  onRefresh: () => void;
  onRequestExemption: () => void;
}

export function AndroidBackgroundControls({
  running,
  exempt,
  busy,
  onRefresh,
  onRequestExemption,
}: AndroidBackgroundControlsProps) {
  useEffect(() => {
    if (isAndroidBackground()) {
      void onRefresh();
    }
    // Refresh once when the section mounts; the service state only
    // changes through this screen or the notification action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isAndroidBackground()) {
    return null;
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Print service</p>
          <p className="text-xs text-muted-foreground">
            Keeps the print queue running after the app is swiped away. Stop it
            from its notification.
          </p>
        </div>
        <Badge variant={running ? "success" : "secondary"}>
          {running == null ? "…" : running ? "running" : "stopped"}
        </Badge>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Ignore battery optimizations</p>
          <p className="text-xs text-muted-foreground">
            Otherwise Doze and app standby defer prints. Opens the system
            screen; your choice, never automatic.
          </p>
        </div>
        <Badge variant={exempt ? "success" : "secondary"}>
          {exempt == null ? "…" : exempt ? "allowed" : "not allowed"}
        </Badge>
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={onRequestExemption}
          data-testid="settings-battery-exemption"
        >
          {busy ? "Working…" : "Request exemption"}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onRefresh}>
          Refresh status
        </Button>
      </div>
    </div>
  );
}
