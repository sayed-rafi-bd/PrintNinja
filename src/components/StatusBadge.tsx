import { useTranslation } from "react-i18next";
import {
  Ban,
  Bookmark,
  CheckCircle2,
  Clock,
  EyeOff,
  Globe,
  Loader2,
  PencilLine,
  Wifi,
  WifiOff,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

/**
 * The shared status vocabulary. Every place that shows a job, template, or
 * printer state goes through this table, so a state looks and reads the same
 * on every screen. Add new states here, not in pages.
 */
export const STATUS = {
  // Print jobs
  success: { tone: "success", icon: CheckCircle2, label: "Printed" },
  failed: { tone: "danger", icon: XCircle, label: "Failed" },
  queued: { tone: "warning", icon: Clock, label: "Queued" },
  printing: { tone: "info", icon: Loader2, label: "Printing", spin: true },
  cancelled: { tone: "neutral", icon: Ban, label: "Cancelled" },
  // Templates
  draft: { tone: "warning", icon: PencilLine, label: "Draft" },
  published: { tone: "success", icon: Globe, label: "Published" },
  saved: { tone: "info", icon: Bookmark, label: "Saved" },
  withdrawn: { tone: "neutral", icon: EyeOff, label: "Withdrawn" },
  // Printers
  online: { tone: "success", icon: Wifi, label: "Online" },
  offline: { tone: "danger", icon: WifiOff, label: "Offline" },
  // Sync cache (section 6.9)
  synced: { tone: "success", icon: CheckCircle2, label: "Synced" },
  syncing: { tone: "info", icon: Loader2, label: "Syncing", spin: true },
  pending: { tone: "warning", icon: Clock, label: "Pending" },
  conflict: { tone: "danger", icon: XCircle, label: "Conflict" },
} as const satisfies Record<
  string,
  { tone: StatusTone; icon: LucideIcon; label: string; spin?: boolean }
>;

export type StatusKey = keyof typeof STATUS;

const TONE_CLASS: Record<StatusTone, string> = {
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  neutral: "bg-neutral-soft text-neutral",
};

export function isStatusKey(value: string): value is StatusKey {
  return Object.prototype.hasOwnProperty.call(STATUS, value);
}

interface StatusBadgeProps {
  status: StatusKey;
  /** Overrides the translated label, for example "Yours" on a published template. */
  label?: string;
  className?: string;
}

export function StatusBadge({ status, label, className }: StatusBadgeProps) {
  const { t } = useTranslation();
  const def = STATUS[status] as { tone: StatusTone; icon: LucideIcon; label: string; spin?: boolean };
  const Icon = def.icon;
  return (
    <span
      data-status={status}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-2 py-0.5 text-xs font-medium",
        TONE_CLASS[def.tone],
        className,
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn("h-3.5 w-3.5 shrink-0", "spin" in def && def.spin && "motion-safe:animate-spin")}
      />
      {label ?? t(`status.${status}`, { defaultValue: def.label })}
    </span>
  );
}

/** For values that come from data (job.status). Unknown values render neutral. */
export function JobStatusBadge({ status }: { status: string }) {
  if (isStatusKey(status)) return <StatusBadge status={status} />;
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-sm bg-neutral-soft px-2 py-0.5 text-xs font-medium text-neutral">
      {status}
    </span>
  );
}
