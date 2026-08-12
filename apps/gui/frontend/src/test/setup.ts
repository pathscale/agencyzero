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
 * jsdom stores `scrollTop` and clamps nothing.
 *
 * A real engine clamps every assignment to `[0, scrollHeight - clientHeight]`,
 * and code that scrolls relies on it: `element.scrollTop = element.scrollHeight`
 * is the ordinary way to say "go to the bottom" precisely because the platform
 * takes back the overshoot. Under jsdom that assignment sticks, so the offset
 * sits a full viewport past anything the scroller could show and every position
 * measured afterwards is wrong by that much.
 *
 * It made a broken transcript scroll read as fine in tests. Clamping here means
 * a test that stubs `scrollHeight` and `clientHeight` gets browser behaviour for
 * free; one that stubs neither keeps jsdom's zeros, where the clamp is the
 * identity and nothing changes.
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
