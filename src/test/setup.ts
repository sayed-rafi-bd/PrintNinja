import "@testing-library/jest-dom/vitest";

// Mock Tauri API for browser tests
(globalThis as any).__TAURI_INTERNALS__ = undefined;

// Unit tests never touch the real network: external calls (share service,
// GitHub release check) fail fast here, and suites that need them stub
// `fetch` per file.
globalThis.fetch = async () => {
  throw new Error("network disabled in unit tests (stub fetch per file)");
};

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();
Object.defineProperty(window, "localStorage", { value: localStorageMock });
