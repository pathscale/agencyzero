import "@testing-library/jest-dom/vitest";

/**
 * jsdom does not implement `matchMedia`, and `@pathscale/ui`'s barrel calls it
 * at module scope (FloatingDock), so importing any component from the library
 * throws before a test runs. Reports "no match", which is the honest answer
 * from an environment with no layout and no media.
 */
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});
