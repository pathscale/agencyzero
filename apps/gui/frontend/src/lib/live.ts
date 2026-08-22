/**
 * Signal writes that arrive after the component is gone.
 *
 * Solid 2 refuses a reactive write made from a disposed or otherwise owned
 * scope:
 *
 *     [REACTIVE_WRITE_IN_OWNED_SCOPE] Writing to reactive state inside an
 *     owned scope (component, computation) is not allowed.
 *
 * The trap is that this is not contained to the component that did it. The
 * error escapes as `REACTIVITY_HALTED`, after which the *whole app* stops
 * processing updates — the same failure already described at
 * `features/project/Composer.tsx:483` and `features/onboarding/WelcomeFlow.tsx:73`.
 *
 * The shape that hits it is everywhere: an effect fires a backend call and
 * writes the answer in `.then()`. Switch tab, close Settings, or finish
 * onboarding while that call is in flight and the pane disposes first, so the
 * write lands in a scope that no longer exists. Nothing looks wrong at the call
 * site, which is why nine of them accumulated.
 *
 * `whileMounted` states the guard once. It is deliberately the same
 * disposed-flag idiom already used at `features/shell/useAppShell.ts:76`, not
 * `createResource`: this codebase uses no resources anywhere, and the call
 * sites want a plain setter, not a loading/error triple.
 *
 * Must be called during component setup, since it registers `onCleanup`.
 */

import { onCleanup } from "solid-js";

/**
 * A gate that closes when the calling component is disposed.
 *
 * ```ts
 * const alive = whileMounted();
 * void actions.getBuildInfo().then(alive(setBuild)).catch(alive(() => setBuild(null)));
 * ```
 *
 * Wrapping the callback rather than checking a boolean keeps the guard
 * impossible to forget halfway down a `.then()` chain: an unwrapped continuation
 * is visible as one that never mentions `alive`.
 */
export function whileMounted(): <A extends unknown[]>(
  run: (...args: A) => void,
) => (...args: A) => void {
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  return (run) =>
    (...args) => {
      if (disposed) return;
      run(...args);
    };
}
