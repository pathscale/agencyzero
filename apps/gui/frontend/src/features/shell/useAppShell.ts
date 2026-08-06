import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type Accessor, createSignal, onCleanup, onMount } from "solid-js";
import { describeError, log } from "~/lib/log";
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
  closeError: Accessor<string>;
  cancelClose: () => void;
  confirmClose: () => void;
} {
  const { state, actions } = useWorkspace();
  const [isClosing, setIsClosing] = createSignal(false);
  const [closeError, setCloseError] = createSignal("");

  const cancelClose = () => {
    setIsClosing(false);
    setCloseError("");
  };

  // Defensive optional chaining: `purgeProject` leaves some of these records
  // with keys the others do not have, so a value can be absent even though the
  // key exists. A bare `.length`/`.some` on an undefined value throws the same
  // "undefined is not an object" this file must never raise on close.
  const hasLiveWork = () =>
    Object.keys(state.runStatus).length > 0 ||
    Object.values(state.streaming).some((text) => (text?.length ?? 0) > 0) ||
    Object.values(state.running).some((tasks) => (tasks?.length ?? 0) > 0) ||
    Object.values(state.messages).some((messages) =>
      messages?.some((message) => message.moderation?.needsApproval),
    );

  const confirmClose = () => {
    setIsClosing(false);
    setCloseError("");
    // Rust drains persistence away from Tauri's synchronous exit callback, so
    // macOS keeps receiving events instead of showing a beachball. A drain
    // failure must keep the process alive: destroying the window in this catch
    // was exactly how a visibly clean quit discarded a failed checkpoint clear.
    void actions.quitApp().catch((cause) => {
      const detail = describeError(cause);
      log.error(`safe quit was blocked: ${detail}`);
      setCloseError(detail);
      setIsClosing(true);
    });
  };

  const requestClose = () => {
    if (hasLiveWork()) setIsClosing(true);
    else confirmClose();
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

    track(listen("menu:new-project", () => actions.openDraft()));
    track(listen("menu:settings", () => actions.openSettings()));
    track(listen("menu:close-tab", () => actions.closeTab(state.activeKey)));
    track(listen("menu:prev-tab", () => actions.cycleTab(-1)));
    track(listen("menu:next-tab", () => actions.cycleTab(1)));
    track(listen("menu:quit", requestClose));
    // Same drain-then-exec as the Settings button; the menu is just nearer.
    track(listen("menu:restart", () => void actions.relaunchApp()));

    // Fires for the traffic light and anything else that asks the window to go.
    track(
      getCurrentWindow().onCloseRequested((event) => {
        event.preventDefault();
        requestClose();
      }),
    );

    onCleanup(() => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    });
  });

  return { isClosing, closeError, cancelClose, confirmClose };
}
