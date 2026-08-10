import { type JSX, onCleanup, onMount } from "solid-js";

/**
 * Move a live Solid subtree under `body` without using a Portal.
 *
 * Retained views establish containing blocks, which otherwise trap a fixed
 * backdrop inside one cached panel. Moving the already-bound node preserves
 * Solid and Blitz listeners while giving every modal viewport geometry.
 */
export function AppModal(props: {
  labelledBy: string;
  onDismiss: () => void;
  children: JSX.Element;
}): JSX.Element {
  let root!: HTMLDivElement;
  onMount(() => document.body.append(root));
  onCleanup(() => root.remove());
  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-labelledby={props.labelledBy}
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
      onClick={(event) => event.currentTarget === event.target && props.onDismiss()}
      onKeyDown={(event) => event.key === "Escape" && props.onDismiss()}
    >
      {props.children}
    </div>
  );
}
