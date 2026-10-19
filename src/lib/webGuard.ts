/**
 * Web guard: Detects if the app is running in a web browser (not Tauri).
 * For any feature requiring Rust/native code, shows an alert and returns null.
 */

export const isWebMode = (): boolean => {
  return typeof window !== "undefined" && !(window as any).__TAURI_INTERNALS__;
};

export const requireNative = <T>(featureName: string): T | null => {
  if (isWebMode()) {
    window.alert(`"${featureName}" requires the desktop app. Please run PrintNinja as a Tauri application.`);
    return null;
  }
  return undefined as any;
};

export const showWebLimitation = (feature: string) => {
  if (isWebMode()) {
    alert(`"${feature}" is only available in the desktop app. Install PrintNinja on Windows or Android for full functionality.`);
  }
};

export const guardInvoke = async <T = unknown>(
  cmd: string,
  args?: any,
  featureName?: string,
): Promise<T | null> => {
  if (isWebMode()) {
    const name = featureName || cmd;
    alert(`"${name}" requires native code and is not available in the browser. Please use the desktop app.`);
    return null;
  }

  const { invoke } = await import("@/lib/invoke");
  return invoke<T>(cmd, args);
};
