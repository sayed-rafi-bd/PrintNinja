/**
 * Replaces @tauri-apps/api/core invoke for web-safe use.
 * In web mode, throws an error explaining the limitation.
 */

export const tauriInvoke = async <T = unknown>(cmd: string, args?: any): Promise<T> => {
  if (typeof window !== "undefined" && !(window as any).__TAURI_INTERNALS__) {
    throw new Error(`"${cmd}" requires the desktop app. Please run PrintNinja as a Tauri application.`);
  }
  const { invoke } = await import("@/lib/invoke");
  return invoke<T>(cmd, args);
};

export const isNativeAvailable = (): boolean => {
  return typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
};
