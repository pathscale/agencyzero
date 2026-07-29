import "@testing-library/jest-dom/vitest";

/**
 * jsdom has no localStorage that survives between files, and `stores/prefs`
 * reads it at import time. This keeps that path exercised rather than mocked
 * away, so a broken prefs load shows up as a failing test.
 */
const store = new Map<string, string>();

Object.defineProperty(window, "localStorage", {
  writable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  },
});
