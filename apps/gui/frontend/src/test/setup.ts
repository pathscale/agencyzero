import "@testing-library/jest-dom/vitest";
import { delegateEvents, registerDelegatedRoot } from "@solidjs/web";

/*
 * Everything below needs a DOM, and the source-audit files deliberately run
 * under `@vitest-environment node` so they can read the repository with
 * `node:fs`. Guarding here keeps one setup file honest for both rather than
 * splitting it in two.
 */
if (typeof window !== "undefined") {
  installDomTestEnvironment();
}

function installDomTestEnvironment(): void {
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

/**
 * Solid 2 delegates events to *registered containers*, not to the document.
 *
 * `render` in the app registers its root, so a click works everywhere in the
 * real build. `@solidjs/testing-library` 1.0.0-beta.2 does not register the
 * container it creates, so a compiled `onClick` was attached to the element as
 * `$$click` and then never dispatched to: every click, in every test, silently
 * did nothing. It reads as an application bug at each call site rather than as
 * one missing registration, and it is why suites asserting a handler ran
 * reported "expected vi.fn() to be called once, but got 0 times" while the
 * same interaction worked when driven by hand.
 *
 * Registering `document.body` covers every container, because testing-library
 * mounts each one inside it. Solid 1 delegated to the document and needed none
 * of this.
 */
registerDelegatedRoot(document.body);
delegateEvents(["click", "input", "change", "keydown", "keyup", "pointerdown", "pointerup"]);
}
