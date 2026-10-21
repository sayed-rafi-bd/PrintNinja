import { useEffect, useRef } from "react";

interface Handlers {
  onPalette: () => void;
  onHelp: () => void;
  /** Called with the second key of "g then key". Return true if handled. */
  onGoto: (key: string) => boolean;
}

/** True when a key press belongs to a text field or the code editor, not the app. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.closest(".cm-editor")) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

const GOTO_WINDOW_MS = 1200;

/**
 * Ctrl or Cmd + K opens the palette, "?" opens the shortcut list, and
 * "g" then a letter jumps to a page. Letter shortcuts never fire while typing.
 */
export function useGlobalShortcuts({ onPalette, onHelp, onGoto }: Handlers) {
  const pendingGoto = useRef<number | null>(null);

  useEffect(() => {
    const clearPending = () => {
      if (pendingGoto.current != null) window.clearTimeout(pendingGoto.current);
      pendingGoto.current = null;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        clearPending();
        onPalette();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target))
        return;

      if (pendingGoto.current != null) {
        const handled = onGoto(e.key.toLowerCase());
        clearPending();
        if (handled) e.preventDefault();
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        onHelp();
      } else if (e.key.toLowerCase() === "g") {
        pendingGoto.current = window.setTimeout(clearPending, GOTO_WINDOW_MS);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearPending();
    };
  }, [onPalette, onHelp, onGoto]);
}
