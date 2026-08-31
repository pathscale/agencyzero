/// <reference types="@rsbuild/core/types" />

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  readonly __AGENCYZERO_BLITZ__?: boolean;
}

declare module "*.css";
declare module "*.svg" {
  const src: string;
  export default src;
}

/**
 * The page mount.
 *
 * `<web-view>` is not a component and renders nothing on its own: Rust looks
 * the element up by id and attaches the page's document to that node
 * (`apps/gui/src/browse.rs`). It is declared here because it has no HTML
 * definition to inherit one from, and without a declaration the Browse pane
 * fails to typecheck on an element the engine defines rather than the DOM.
 */
declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "web-view": JSX.HTMLAttributes<HTMLElement> & {
        id?: string;
        "data-tab-id"?: string;
      };
    }
  }
}
