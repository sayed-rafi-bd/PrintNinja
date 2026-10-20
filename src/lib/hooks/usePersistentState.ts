import { useCallback, useState } from "react";

/**
 * Like `useState`, but the value is kept in localStorage under `key`, so it
 * survives a reload. A stored value that `isValid` rejects (an old format, or
 * hand-edited) is ignored and `initial` is used instead. Storage can be
 * unavailable or full; the value then just lasts for the session.
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  isValid: (value: unknown) => value is T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return initial;
      const parsed: unknown = JSON.parse(raw);
      return isValid(parsed) ? parsed : initial;
    } catch {
      return initial;
    }
  });

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Not persisted; the in-memory value still works.
      }
    },
    [key],
  );

  return [value, set];
}
