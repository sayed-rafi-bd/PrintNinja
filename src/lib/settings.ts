/**
 * Small settings helpers shared outside the Settings page.
 * Settings live in SQLite through Tauri; in the browser preview (and when the
 * backend is unavailable) they fall back to localStorage so the UI keeps working.
 */
const lsKey = (key: string) => `printninja-setting:${key}`;

export async function readSetting(key: string): Promise<string | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const v = await invoke<string | null>("get_setting", { key });
    if (v != null && v !== "") return v;
  } catch {
    /* web mode or backend unavailable */
  }
  try {
    const v = localStorage.getItem(lsKey(key));
    return v === "" ? null : v;
  } catch {
    return null;
  }
}

export async function writeSetting(key: string, value: string): Promise<void> {
  try {
    localStorage.setItem(lsKey(key), value);
  } catch {
    /* storage unavailable */
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_setting", { key, value });
  } catch {
    /* kept in localStorage */
  }
}

/** Synchronous read of the local cache, used to avoid a flash before the DB answers. */
export function readCachedSetting(key: string): string | null {
  try {
    const v = localStorage.getItem(lsKey(key));
    return v === "" ? null : v;
  } catch {
    return null;
  }
}
