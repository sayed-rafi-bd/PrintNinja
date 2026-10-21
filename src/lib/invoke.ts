import { invoke as tauriInvoke, type InvokeArgs } from "@tauri-apps/api/core";

/**
 * Drop-in replacement for `invoke` from @tauri-apps/api/core that logs every
 * IPC call (name, args, duration) and every failure to the webview console.
 */
export async function invoke<T = unknown>(
  cmd: string,
  args?: InvokeArgs,
): Promise<T> {
  const t0 = performance.now();
  try {
    const res = await tauriInvoke<T>(cmd, args);
    console.debug(
      `[invoke] ${cmd} ok ${(performance.now() - t0).toFixed(0)}ms`,
      args,
    );
    return res;
  } catch (e) {
    console.error(`[invoke] ${cmd} FAILED`, args, e);
    throw e;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (e) =>
    console.error("[unhandled]", e.reason),
  );
  window.addEventListener("error", (e) =>
    console.error("[error]", e.error ?? e.message),
  );
}
