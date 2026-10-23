import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isWebMode } from "@/lib/settings";

export type UpdateProgress = {
  downloaded: number;
  total: number | undefined;
};

export type UpdaterDeps = {
  checkFn?: () => Promise<{
    version: string;
    downloadAndInstall: (
      onEvent?: (e: {
        event: string;
        data: { chunkLength?: number; contentLength?: number };
      }) => void,
    ) => Promise<void>;
  } | null>;
  relaunchFn?: () => Promise<void>;
};

/**
 * Checks for an update, downloads + installs it, then relaunches.
 * Returns the installed version, or null when already up to date.
 * `onProgress` receives running byte counts for a progress bar.
 * Throws on check/download/install failure so callers can toast.
 */
export async function checkAndInstall(
  onProgress?: (p: UpdateProgress) => void,
  deps: UpdaterDeps = {},
): Promise<string | null> {
  const doCheck = deps.checkFn ?? check;
  const doRelaunch = deps.relaunchFn ?? relaunch;
  const update = await doCheck();
  if (!update) return null;
  const version = update.version;
  let downloaded = 0;
  let total: number | undefined;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength;
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength ?? 0;
    }
    onProgress?.({ downloaded, total });
  });
  await doRelaunch();
  return version;
}

/** False in the browser preview/CI and on mobile builds, where the
 * updater backend is unavailable. The Settings UI hides the update
 * row when this is false. */
export function isUpdaterSupported(): boolean {
  return !isWebMode();
}
