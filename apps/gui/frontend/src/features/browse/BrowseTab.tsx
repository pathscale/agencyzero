import { Input } from "@pathscale/ui";
import type { JSX } from "@solidjs/web";
import { createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import { Button } from "~/components/Button";
import { Icon } from "~/components/Icon";
import { whileMounted } from "~/lib/live";
import { tx } from "~/stores/i18n";
import { useWorkspace } from "~/stores/workspace";
import type { BrowseDebugEntry, BrowseView } from "~/types";

/**
 * The browsing surface: a page, rendered by the same engine that draws this
 * window.
 *
 * # Where the state lives
 *
 * Not here. Tabs, history and the address are held in Rust
 * (`apps/gui/src/browse.rs` over `ps-browse-core`), because the page itself is
 * a document the engine owns and a second copy in the store would be a second
 * truth to disagree with. This pane holds the last snapshot it was handed and
 * replaces it wholesale — every command returns the whole surface, and
 * `browse:state` delivers the changes nobody asked for, like a load finishing.
 *
 * # The mount
 *
 * `<web-view>` is not a control. It is the rendezvous point between this
 * document and the page's: Rust looks it up by id and attaches a sub-document
 * to that node. Nothing is rendered into it from here, and its id must keep
 * matching `mount_node` in `browse.rs` — when that drifts the page loads
 * correctly and appears nowhere, which is indistinguishable from a page that
 * failed.
 */
export function BrowseTab(): JSX.Element {
  const { actions } = useWorkspace();
  const [view, setView] = createSignal<BrowseView | null>(null);
  const [address, setAddress] = createSignal("");
  /** True while the address bar has focus, so a refresh does not fight typing. */
  const [editing, setEditing] = createSignal(false);
  const [debugOpen, setDebugOpen] = createSignal(false);
  const [debug, setDebug] = createSignal<BrowseDebugEntry[]>([]);

  const alive = whileMounted();

  const active = () => {
    const current = view();
    return current?.tabs.find((tab) => tab.id === current.active) ?? null;
  };

  /** Adopt a snapshot, leaving the address bar alone while it is being typed in. */
  const adopt = (next: BrowseView) => {
    setView(next);
    if (!editing()) {
      const tab = next.tabs.find((candidate) => candidate.id === next.active);
      setAddress(tab && tab.url !== "about:blank" ? tab.url : "");
    }
  };

  const refresh = (): void => {
    void actions
      .browseState()
      .then(alive(adopt))
      .catch(alive(() => setView(null)));
  };

  onSettled(() => {
    refresh();

    // The surface changes without being asked: a fetch finishes, a page
    // mounts. Re-reading the whole state rather than patching from the payload
    // keeps one code path for "draw the surface".
    //
    // The unlisten is owned here. This pane is unmounted whenever the window
    // changes tab, and a subscription that outlived it would write into a
    // disposed scope — which in Solid 2 halts reactivity for the whole app,
    // not just for this component.
    let unlisten: (() => void) | undefined;
    void actions.onBrowseState(refresh).then(
      alive((stop: () => void) => {
        unlisten = stop;
      }),
    );
    onCleanup(() => unlisten?.());
  });

  const run = (work: Promise<BrowseView>) => {
    void work.then(alive(adopt)).catch(alive(() => refresh()));
  };

  const submit = (event: Event) => {
    event.preventDefault();
    const tab = active();
    if (!tab) return;
    setEditing(false);
    run(actions.browseNavigate(tab.id, address()));
  };

  const refreshDebug = () => {
    void actions
      .browseDebugLog()
      .then(alive(setDebug))
      .catch(alive(() => setDebug([])));
  };

  return (
    <div
      data-active-tab="browse"
      class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-panel border border-az-hairline bg-az-sunken"
    >
      {/* The browsing tab strip, which is not the window's tab strip. These are
          pages inside one workspace tab. */}
      <div class="az-scroll-x flex flex-none items-center gap-1.5 border-az-hairline border-b px-2 py-1.5">
        <For each={view()?.tabs ?? []}>
          {(tab) => (
            <div
              class={`flex h-7 min-w-0 max-w-[220px] shrink-0 items-center gap-1.5 rounded-full pr-1 pl-3 transition-colors ${
                tab.id === view()?.active
                  ? "bg-az-tab text-base-content"
                  : "text-az-muted hover:bg-az-hover hover:text-base-content"
              }`}
            >
              <Button
                id={`browse-tab-${tab.id}`}
                type="button"
                onClick={() => run(actions.browseSelectTab(tab.id))}
                aria-label={tx("Show {title}", { title: tab.title })}
                aria-current={tab.id === view()?.active ? "true" : "false"}
                class="min-w-0 flex-1 truncate text-left text-ui-detail"
              >
                {tab.title}
              </Button>
              {/*
                `role="img"`, because a bare span carries no role and an
                aria-label on a roleless element is not announced. The dot is
                the only thing that says how the last load went.
              */}
              <span
                role="img"
                aria-label={tx("Status: {status}", { status: tab.status })}
                class={`size-[6px] shrink-0 rounded-full ${STATUS_TONE[tab.status]}`}
              />
              <Button
                id={`browse-tab-${tab.id}-close`}
                type="button"
                onClick={() => run(actions.browseCloseTab(tab.id))}
                aria-label={tx("Close tab")}
                class="flex size-5 shrink-0 items-center justify-center rounded-full text-az-muted hover:bg-az-hover hover:text-base-content"
              >
                <Icon name="x" class="text-ui-caption" />
              </Button>
            </div>
          )}
        </For>
        <Button
          id="browse-new-tab"
          type="button"
          onClick={() => run(actions.browseOpenTab())}
          title={tx("New tab")}
          aria-label={tx("New tab")}
          class="flex size-7 shrink-0 items-center justify-center rounded-full border border-primary/22 border-dashed text-az-muted hover:border-primary hover:bg-az-chip hover:text-primary"
        >
          <Icon name="plus" class="text-ui-detail" />
        </Button>
      </div>

      {/* Address bar and history controls. */}
      <form
        onSubmit={submit}
        class="flex flex-none items-center gap-1.5 border-az-hairline border-b px-2 py-1.5"
      >
        <Button
          id="browse-back"
          type="button"
          disabled={!active()?.canGoBack}
          onClick={() => {
            const tab = active();
            if (tab) run(actions.browseBack(tab.id));
          }}
          title={tx("Back")}
          aria-label={tx("Back")}
          class="flex size-7 shrink-0 rotate-180 items-center justify-center rounded-full text-az-muted transition-colors hover:bg-az-hover hover:text-base-content disabled:opacity-35"
        >
          <Icon name="chevron-right" class="text-ui-detail" />
        </Button>
        <Button
          id="browse-forward"
          type="button"
          disabled={!active()?.canGoForward}
          onClick={() => {
            const tab = active();
            if (tab) run(actions.browseForward(tab.id));
          }}
          title={tx("Forward")}
          aria-label={tx("Forward")}
          class="flex size-7 shrink-0 items-center justify-center rounded-full text-az-muted transition-colors hover:bg-az-hover hover:text-base-content disabled:opacity-35"
        >
          <Icon name="chevron-right" class="text-ui-detail" />
        </Button>
        <Button
          id="browse-reload"
          type="button"
          onClick={() => {
            const tab = active();
            if (tab) run(actions.browseReload(tab.id));
          }}
          title={tx("Reload")}
          aria-label={tx("Reload")}
          class="flex size-7 shrink-0 items-center justify-center rounded-full text-az-muted transition-colors hover:bg-az-hover hover:text-base-content"
        >
          <Icon name="refresh-cw" class="text-ui-detail" />
        </Button>
        {/*
          `Input.Field`, not a bare HTML input element.
          `scripts/check-ui-controls.ts` bans the raw elements outright and
          requires every value-bearing control to be one the QA suite already
          drives — otherwise this ships an address bar that no rendered test
          can type into. The ban is a line regex, so it also catches the
          element named in a comment; that is why this sentence spells it out
          rather than showing it.
        */}
        <Input.Field
          id="browse-address"
          type="text"
          value={address()}
          aria-label={tx("Address")}
          placeholder={tx("Enter an address")}
          onInput={(event) => setAddress(event.currentTarget.value)}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          class="h-7 min-w-0 flex-1 rounded-full bg-az-chip px-3 text-base-content text-ui-detail outline-none focus:ring-1 focus:ring-primary/40"
        />
        <Button
          id="browse-debug-toggle"
          type="button"
          onClick={() => {
            const next = !debugOpen();
            setDebugOpen(next);
            if (next) refreshDebug();
          }}
          title={tx("What the browser did")}
          aria-label={tx("What the browser did")}
          aria-pressed={debugOpen() ? "true" : "false"}
          class={`flex size-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-az-hover ${
            debugOpen() ? "text-primary" : "text-az-muted hover:text-base-content"
          }`}
        >
          <Icon name="terminal" class="text-ui-detail" />
        </Button>
      </form>

      {/*
        A build with no renderer says so.
        The whole surface still works — tabs, history, the address bar — and
        silently showing an empty viewport instead would look exactly like a
        page that never loads.
      */}
      <Show when={view() && !view()!.canRender}>
        <p
          role="status"
          class="flex-none border-warning/30 border-b bg-warning/10 px-3 py-1.5 text-ui-caption text-warning"
        >
          {tx("This build has no page renderer, so addresses resolve but nothing is drawn.")}
        </p>
      </Show>

      {/* The page. */}
      <div class="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-az-page">
        <Show
          when={active() && active()!.url !== "about:blank"}
          fallback={
            <div class="flex h-full flex-col items-center justify-center gap-2 text-center">
              <Icon name="search" class="text-az-muted text-ui-hero" />
              <p class="text-az-title text-ui-body-lg">{tx("Nothing open")}</p>
              <p class="max-w-[380px] text-az-muted text-ui-detail">
                {tx("Type an address above. Pages render with the same engine as this window.")}
              </p>
            </div>
          }
        >
          {/*
            The mount, and only the mount. Rust finds this node by id and
            attaches the page's document to it; anything rendered inside would
            be replaced without warning.
          */}
          <web-view
            id={`az-browse-page-${view()?.active ?? 0}`}
            data-tab-id={String(view()?.active ?? 0)}
            class="block size-full"
          />
        </Show>
      </div>

      <Show when={debugOpen()}>
        <div class="flex max-h-[200px] flex-none flex-col overflow-hidden border-az-hairline border-t">
          <div class="flex flex-none items-center justify-between px-3 py-1">
            <p class="font-semibold text-az-muted text-ui-caption">{tx("What the browser did")}</p>
            <Button
              id="browse-debug-refresh"
              type="button"
              onClick={refreshDebug}
              aria-label={tx("Refresh")}
              class="text-az-muted text-ui-caption hover:text-base-content"
            >
              {tx("Refresh")}
            </Button>
          </div>
          <ul class="az-scroll-y min-h-0 flex-1 px-3 pb-2">
            <For
              each={debug()}
              fallback={
                <li class="text-az-muted text-ui-caption">{tx("Nothing recorded yet.")}</li>
              }
            >
              {(entry) => (
                <li
                  data-selectable
                  class={`font-mono text-ui-caption-sm leading-[1.5] ${LEVEL_TONE[entry.level]}`}
                >
                  <span class="text-az-muted">{entry.source}</span> {entry.message}
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
    </div>
  );
}

/** The status dot's colour, by how the last load went. */
const STATUS_TONE: Record<string, string> = {
  empty: "bg-az-hairline",
  loading: "bg-info",
  loaded: "bg-success",
  partial: "bg-warning",
  degraded: "bg-warning",
  error: "bg-error",
};

const LEVEL_TONE: Record<string, string> = {
  info: "text-az-body",
  warn: "text-warning",
  error: "text-error",
};
