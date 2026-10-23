import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import { RefreshCw } from "lucide-react";
import { useShareStatus } from "@/lib/shell/useShareStatus";
import { syncNow, useSyncStatus } from "@/lib/sync/useSyncStatus";

/**
 * Visible sync state for the Settings → Share tab. The topbar only
 * carries badges and a hover tooltip (and hides on phones), so a stuck
 * queue's failure reason had nowhere to be read. This card shows the
 * connection, the queue, the last sync time and — when set — the last
 * error as plain text, plus a manual Sync now (the phones' only one).
 */
export function SyncStatusCard() {
  const { t } = useTranslation();
  const share = useShareStatus();
  const sync = useSyncStatus();
  const [busy, setBusy] = useState(false);

  const online = share.state === "online";
  const syncing = busy || sync.state === "syncing";

  const connection =
    share.state === "online"
      ? t("shell.share_online", { handle: share.handle })
      : share.state === "offline"
        ? t("shell.share_offline")
        : share.state === "signed_out"
          ? t("shell.share_signed_out")
          : t("settings_page.sync_unconfigured");

  const onSyncNow = async () => {
    if (busy || !online) return;
    setBusy(true);
    try {
      await syncNow();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t("settings_page.sync_status")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {t("settings_page.sync_connection")}
          </p>
          {share.state === "online" ? (
            <StatusBadge
              status="online"
              label={share.handle || t("status.online")}
            />
          ) : share.state === "offline" ? (
            <StatusBadge status="offline" />
          ) : (
            <span className="text-sm">{connection}</span>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {t("settings_page.sync_queue")}
          </p>
          {sync.state === "conflict" ? (
            <StatusBadge status="conflict" />
          ) : syncing ? (
            <StatusBadge status="syncing" />
          ) : sync.pending > 0 ? (
            <StatusBadge
              status="pending"
              label={t("shell.sync_pending", { count: sync.pending })}
            />
          ) : (
            <StatusBadge status="synced" />
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {t("settings_page.sync_last")}
          </p>
          <span className="text-sm">
            {sync.lastPullAt
              ? t("shell.sync_synced", { time: sync.lastPullAt })
              : t("settings_page.sync_never")}
          </span>
        </div>

        {sync.lastError && (
          <p role="alert" className="text-sm text-danger">
            {t("shell.sync_failed", { error: sync.lastError })}
          </p>
        )}

        <Button
          variant="outline"
          onClick={() => void onSyncNow()}
          disabled={!online || syncing}
          title={
            online ? t("shell.sync_now") : t("settings_page.sync_sign_in_first")
          }
        >
          <RefreshCw className="h-4 w-4 mr-2" aria-hidden="true" />
          {syncing ? t("shell.sync_syncing") : t("shell.sync_now")}
        </Button>
        {!online && (
          <p className="text-xs text-muted-foreground">
            {t("settings_page.sync_sign_in_first")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
