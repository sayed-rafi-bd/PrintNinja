import { invoke } from "@/lib/invoke";

const PLUGIN = "plugin:android-print";

/** True inside the Android app (WebView user agent). Desktop and web
 * builds return false; every function below no-ops or reports
 * unsupported there instead of throwing at import time. */
export const isAndroid = (): boolean =>
  typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

function plugin<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(`${PLUGIN}|${cmd}`, args);
}

/** Ensures the foreground print service is running. Safe to call on
 * every launch: the service is idempotent, and non-Android builds
 * resolve false instead of failing. */
export async function ensureBackgroundService(): Promise<boolean> {
  if (!isAndroid()) return false;
  try {
    return await plugin<boolean>("start_background_service");
  } catch {
    return false;
  }
}

export async function stopBackgroundService(): Promise<void> {
  if (!isAndroid()) return;
  await plugin<void>("stop_background_service");
}

export async function isBackgroundServiceRunning(): Promise<boolean> {
  if (!isAndroid()) return false;
  try {
    return await plugin<boolean>("is_background_service_running");
  } catch {
    return false;
  }
}

/**
 * Opens the system battery-optimization exemption screen for the app.
 * Doze and app standby otherwise defer the queue worker and the local
 * API server. Call only from an explicit user toggle — never silently.
 * Resolves true when the screen was shown, false when already exempt
 * or the OS cannot show it.
 */
export async function requestBatteryExemption(): Promise<boolean> {
  if (!isAndroid()) return false;
  try {
    return await plugin<boolean>("request_battery_exemption");
  } catch {
    return false;
  }
}

export async function isBatteryExemptionGranted(): Promise<boolean> {
  if (!isAndroid()) return false;
  try {
    return await plugin<boolean>("is_battery_exemption_granted");
  } catch {
    return false;
  }
}
