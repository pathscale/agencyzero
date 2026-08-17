import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type Accessor, createSignal, onCleanup, onSettled } from "solid-js";
import { describeError, log } from "~/lib/log";
import { isTauri } from "~/lib/platform";
import { useWorkspace } from "~/stores/workspace";

/**
 * The bridge between the native shell and the window's own state.
 *
 * Two jobs. Menu items carry ids rather than behaviour, so Close Tab and the
 * tab-cycling items arrive here as events and are answered by the same actions
 * the strip uses. Every route out of the app — the traffic light, ⌘Q, the
 * menu's Quit — drains persistence before exiting. Agent runs belong to the
 * persistent sidecar, so closing this client detaches without warning.
 *
 * Inert outside Tauri: there is no menu and no window to close.
 */
export function useAppShell(): {
  isClosing: Accessor<boolean>;
  closeError: Accessor<string>;
  quitsProxy: Accessor<boolean>;
  persistenceFailure: Accessor<string>;
  cancelClose: () => void;
  confirmClose: () => void;
} {
  const { state, actions } = useWorkspace();
  const [isClosing, setIsClosing] = createSignal(false);
  const [closeError, setCloseError] = createSignal("");
  const [quitsProxy, setQuitsProxy] = createSignal(false);
  const [persistenceFailure, setPersistenceFailure] = createSignal("");

  const cancelClose = () => {
    setIsClosing(false);
    setCloseError("");
    setQuitsProxy(false);
  };

  const confirmClose = () => {
    setIsClosing(false);
    setCloseError("");
    // Rust drains persistence away from Tauri's synchronous exit callback, so
    // macOS keeps receiving events instead of showing a beachball. A drain
    // failure must keep the process alive: destroying the window in this catch
    // was exactly how a visibly clean quit discarded a failed checkpoint clear.
    const quit = quitsProxy() ? actions.quitAppAndProxy() : actions.quitApp();
    void quit.catch((cause) => {
      const detail = describeError(cause);
      log.error(`safe quit was blocked: ${detail}`);
      setCloseError(detail);
      setIsClosing(true);
    });
  };

  const requestClose = confirmClose;
  const requestQuitAll = () => {
    setCloseError("");
    if ((state.agencyProxy?.activeRuns ?? 0) === 0) {
      setQuitsProxy(false);
      void actions.quitAppAndProxy().catch((cause) => {
        setCloseError(describeError(cause));
        setQuitsProxy(true);
        setIsClosing(true);
      });
      return;
    }
    setQuitsProxy(true);
    setIsClosing(true);
  };

  onSettled(() => {
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
    track(listen("menu:quit-all", requestQuitAll));
    // Register first, then query the retained backend failure. This ordering
    // covers both sides of startup without a gap where an event can be lost.
    void (async () => {
      try {
        const unlisten = await listen<{ message: string }>("persistence:failed", ({ payload }) => {
          log.error(`persistence worker failed: ${payload.message}`);
          setPersistenceFailure(payload.message);
        });
        if (disposed) {
          unlisten();
          return;
        }
        unlisteners.push(unlisten);
        const retained = await invoke<string | null>("get_persistence_failure");
        if (retained) {
          log.error(`persistence worker failed before listener registration: ${retained}`);
          setPersistenceFailure(retained);
        }
      } catch (cause) {
        log.error(`could not monitor persistence health: ${describeError(cause)}`);
      }
    })();
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

  return { isClosing, closeError, quitsProxy, persistenceFailure, cancelClose, confirmClose };
}
