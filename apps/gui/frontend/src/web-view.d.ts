/**
 * The page mount.
 *
 * `<web-view>` is not a component and renders nothing on its own: Rust looks
 * the element up by id and attaches the page's document to that node
 * (`apps/gui/src/browse.rs`). It is declared here because it has no HTML
 * definition to inherit one from, and without a declaration the Browse pane
 * fails to typecheck on an element the engine defines rather than the DOM.
 *
 * A file of its own, with an `export {}`, and both halves matter. A
 * `declare module` in a *script* file declares an ambient module that
 * **replaces** the real one — putting this in `env.d.ts` made every
 * `JSX.Element` in the app resolve to nothing. Only inside a module is it the
 * augmentation it reads as.
 */
export {};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "web-view": HTMLAttributes<HTMLElement> & {
        "data-tab-id"?: string;
      };
    }
  }
}
