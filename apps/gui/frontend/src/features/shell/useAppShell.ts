import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type Accessor, createSignal, onCleanup, onMount } from "solid-js";
import { isTauri } from "~/lib/platform";
import { useWorkspace } from "~/stores/workspace";

/**
 * The bridge between the native shell and the window's own state.
 *
 * Two jobs. Menu items carry ids rather than behaviour, so Close Tab and the
 * tab-cycling items arrive here as events and are answered by the same actions
 * the strip uses. And every route out of the app — the traffic light, ⌘Q, the
 * menu's Quit — is intercepted and routed through one confirmation, because
 * closing the window ends every run it is supervising.
 *
 * Inert outside Tauri: there is no menu and no window to close.
 */
export function useAppShell(): {
  isClosing: Accessor<boolean>;
  cancelClose: () => void;
  confirmClose: () => void;
} {
  const { state, actions } = useWorkspace();
  const [isClosing, setIsClosing] = createSignal(false);

  const cancelClose = () => setIsClosing(false);

  const confirmClose = () => {
    setIsClosing(false);
    // destroy(), not close(): close() re-enters the same close-requested
    // handler that opened this dialog, and the window never actually goes.
    void getCurrentWindow().destroy();
  };

  onMount(() => {
    if (!isTauri()) return;

    const unlisteners: UnlistenFn[] = [];
    let disposed = false;

    const track = (pending: Promise<UnlistenFn>) => {
      void pending.then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      });
    };

    track(listen("menu:close-tab", () => actions.closeTab(state.activeKey)));
    track(listen("menu:prev-tab", () => actions.cycleTab(-1)));
    track(listen("menu:next-tab", () => actions.cycleTab(1)));
    track(listen("menu:quit", () => setIsClosing(true)));

    // Fires for the traffic light and anything else that asks the window to go.
    track(
      getCurrentWindow().onCloseRequested((event) => {
        event.preventDefault();
        setIsClosing(true);
      }),
    );

    onCleanup(() => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    });
  });

  return { isClosing, cancelClose, confirmClose };
}
