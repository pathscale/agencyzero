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

/**
 * jsdom stores `scrollTop` but does not clamp it. Real scroll containers clamp
 * every assignment to their reachable range, and the transcript's bottom
 * contract depends on that behavior. Installing the platform rule here keeps
 * scroll tests from passing with a viewport parked beyond all visible content.
 */
const scrollTops = new WeakMap<Element, number>();
Object.defineProperty(Element.prototype, "scrollTop", {
  configurable: true,
  get(this: Element) {
    return scrollTops.get(this) ?? 0;
  },
  set(this: Element, value: number) {
    const limit = Math.max(0, this.scrollHeight - this.clientHeight);
    scrollTops.set(this, Math.max(0, Math.min(limit, Number(value) || 0)));
  },
});
