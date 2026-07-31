import { Toggle } from "@pathscale/ui";
import { createEffect, createSignal, For, type JSX, Show } from "solid-js";
import { Icon } from "~/components/Icon";
import { SectionPanel } from "~/components/Panel";
import { ItemMarker } from "~/components/StatusDot";
import { clockTime, elapsed, taskMeta } from "~/lib/format";
import { statusSuffix } from "~/lib/labels";
import { describeError, log } from "~/lib/log";
import { prefs, togglePanelSection } from "~/stores/prefs";
import { useNow, useWorkspace } from "~/stores/workspace";
import type { Project, ProjectItem } from "~/types";

/**
 * The project's right-hand column: Items · Running · Task log · Agent I/O ·
 * Settings.
 *
 * This replaced the old left sidebar. Open state lives in `UiPrefs`, per
 * install rather than per project, so the panel you left open stays open when
 * you switch tabs.
 */
export function ProjectPanel(props: { project: Project }): JSX.Element {
  const { state, itemsFor, openItemCount } = useWorkspace();

  const running = () => state.running[props.project.id] ?? [];
  const log = () => state.taskLog[props.project.id] ?? [];
  const io = () => state.agentIo[props.project.id] ?? [];

  return (
    <div class="az-scroll flex w-[322px] flex-none flex-col gap-2.5">
      <SectionPanel
        icon="list-checks"
        title="Items"
        count={openItemCount(props.project.id)}
        isOpen={prefs.panelSections.items}
        onToggle={() => togglePanelSection("items")}
        class="flex-none"
      >
        <ItemList projectId={props.project.id} items={itemsFor(props.project.id)} />
      </SectionPanel>

      <SectionPanel
        title="Running"
        count={running().length}
        countTone="primary"
        trailing={
          <span
            class={`size-2 rounded-full ${running().length ? "az-halo-primary bg-primary" : "bg-white/22"}`}
          />
        }
        isOpen={prefs.panelSections.running}
        onToggle={() => togglePanelSection("running")}
        class="flex-none"
      >
        <RunningList projectId={props.project.id} />
      </SectionPanel>

      {/*
        The min-height applies only while open: a collapsed section holding
        160px of blank space is not collapsed, it is furniture.
      */}
      <SectionPanel
        icon="history"
        title="Task log"
        count={state.logTotals[props.project.id] ?? log().length}
        lead={
          <>
            <CopyLogButton projectId={props.project.id} />
            <ClearLogButton projectId={props.project.id} />
          </>
        }
        isOpen={prefs.panelSections.log}
        onToggle={() => togglePanelSection("log")}
        class={prefs.panelSections.log ? "flex min-h-[160px] flex-col" : "flex-none"}
      >
        <TaskLogList projectId={props.project.id} />
      </SectionPanel>

      <SectionPanel
        icon="terminal"
        title="Agent I/O"
        count={io().length}
        isOpen={prefs.panelSections.io}
        onToggle={() => togglePanelSection("io")}
        class={prefs.panelSections.io ? "flex min-h-[160px] flex-col" : "flex-none"}
      >
        <AgentIoList projectId={props.project.id} />
      </SectionPanel>

      {/* Last, deliberately: directories and the moderator toggle are set once
          and revisited rarely, and they were costing the working sections the
          top of the column. */}
      <SettingsSection project={props.project} />
    </div>
  );
}

/**
 * The raw exchange with the agent: what went out, and what came back.
 *
 * This is the crate's event stream, not the process's literal stdout —
 * `agent-abstraction` parses stdout into events and does not hand back the raw
 * lines. A line it could not read shows up as `unparsed`, which is the closest
 * thing to "the CLI said something we did not understand" and the one case
 * worth staring at.
 *
 * Newest last, like a terminal, and it does not survive a restart: this answers
 * "what just happened", and the durable copy is the log file.
 */
/**
 * Whether this project records its raw exchange to the database.
 *
 * Off by default and per project: a turn emits a text event per delta, so
 * recording everything would put continuous write load on the store the whole
 * workspace depends on, for data whose value drops off within minutes. Turn it
 * on for the project you are debugging.
 */
function IoPersistToggle(props: { projectId: string }): JSX.Element {
  const { actions, isLive } = useWorkspace();
  const [enabled, setEnabled] = createSignal(false);

  // Read once per project; the flag only changes from this control.
  createEffect(() => {
    const id = props.projectId;
    void actions
      .getIoPersist(id)
      .then(setEnabled)
      .catch((cause) => log.warn(`could not read the I/O recording flag: ${describeError(cause)}`));
  });

  const toggle = async (next: boolean): Promise<void> => {
    setEnabled(next);
    try {
      await actions.setIoPersist(props.projectId, next);
    } catch (cause) {
      // Put it back: the control must not claim a setting that did not save.
      setEnabled(!next);
      log.error(`could not change I/O recording: ${describeError(cause)}`);
    }
  };

  return (
    <label
      class="flex cursor-pointer items-center gap-2 px-3.5 pb-2 text-[11px] text-az-muted"
      title="Keep this project's raw exchange in the database, so it survives a restart. Off by default: a long run writes thousands of rows."
    >
      <input
        type="checkbox"
        checked={enabled()}
        disabled={!isLive("setIoPersist")}
        onChange={(event) => void toggle(event.currentTarget.checked)}
        class="size-3 accent-primary"
      />
      Keep across restarts
    </label>
  );
}

/** Exported for Home, which shows the task manager's exchange under Recent. */
export function AgentIoList(props: { projectId: string }): JSX.Element {
  const { state } = useWorkspace();
  const lines = () => state.agentIo[props.projectId] ?? [];

  /*
   * Two heights, because this panel has two jobs. Normally it is a tail you
   * glance at, so it stays short and lets the sections above it breathe. When
   * something has gone wrong it is the only thing you want on screen, and a
   * 200px window onto a few hundred entries is unusable.
   */
  const [tall, setTall] = createSignal(false);

  /** Newest last, so it reads like a terminal; the view follows the tail. */
  let scroller: HTMLDivElement | undefined;
  createEffect(() => {
    // Track the count so a new entry scrolls the view down.
    lines().length;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });

  const copyAll = async (): Promise<void> => {
    const text = lines()
      .map(
        (line) =>
          `${line.at} ${line.direction === "sent" ? "->" : "<-"} ${line.kind}\n${line.detail}`,
      )
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch (cause) {
      log.warn(`could not copy the agent log: ${describeError(cause)}`);
    }
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      {/*
        The recording toggle lives outside the empty-state Show: a project with
        no I/O yet is exactly where someone goes to turn recording on, and
        hiding the control until lines exist made the feature look absent.
      */}
      <IoPersistToggle projectId={props.projectId} />
      <Show
        when={lines().length > 0}
        fallback={
          <p class="px-3.5 py-6 text-center text-[11.5px] text-az-muted">
            Nothing sent yet on this project.
          </p>
        }
      >
        <div class="flex flex-none items-center gap-1.5 px-2.5 pb-1.5">
          <button
            type="button"
            onClick={() => setTall((open) => !open)}
            class="rounded-md border border-az-hairline px-2 py-0.5 text-[10.5px] text-az-muted transition-colors hover:border-az-hairline-strong hover:text-base-content"
          >
            {tall() ? "Shrink" : "Expand"}
          </button>
          <button
            type="button"
            onClick={() => void copyAll()}
            class="rounded-md border border-az-hairline px-2 py-0.5 text-[10.5px] text-az-muted transition-colors hover:border-az-hairline-strong hover:text-base-content"
          >
            Copy all
          </button>
          <span class="ml-auto text-[10.5px] text-az-faint">{lines().length} entries</span>
        </div>

        {/*
          `data-selectable` is load-bearing: the app sets `user-select: none`
          globally so the window drags like a native one, and without the opt-in
          this text cannot be selected or copied at all.
        */}
        <div
          ref={scroller}
          data-selectable
          class={`az-scroll flex flex-col gap-1.5 overflow-y-auto px-2.5 pb-2.5 font-mono text-[11px] ${
            tall() ? "max-h-[62vh]" : "max-h-[220px]"
          }`}
        >
          <For each={lines()}>
            {(line) => (
              <div
                class={`flex flex-col gap-0.5 rounded-lg border px-2.5 py-1.5 ${
                  line.direction === "sent"
                    ? "border-primary/22 bg-primary/6"
                    : (IO_TONE[line.kind] ?? "border-az-hairline-soft bg-base-300")
                }`}
              >
                <div class="flex items-baseline gap-1.5">
                  <span
                    class={`shrink-0 ${line.direction === "sent" ? "text-primary" : "text-az-faint"}`}
                  >
                    {line.direction === "sent" ? "→" : "←"}
                  </span>
                  <span class="shrink-0 font-semibold text-az-muted">{line.kind}</span>
                  <span class="ml-auto shrink-0 text-[10px] text-az-faint">
                    {clockTime(line.at)}
                  </span>
                </div>
                {/*
                  `whitespace-pre-wrap` and `break-all`: this is raw agent output,
                  so it has its own newlines and can be one unbroken
                  4000-character token. Either would otherwise push the panel
                  sideways.
                */}
                <pre class="whitespace-pre-wrap break-all text-[10.5px] text-az-bubble-text">
                  {line.detail}
                </pre>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** The kinds worth colouring: a failure and a parser miss should not read as text. */
const IO_TONE: Record<string, string> = {
  stderr: "border-error/30 bg-error/8",
  unparsed: "border-error/30 bg-error/8",
  rate_limit: "border-warning/30 bg-warning/8",
  stop: "border-az-hairline bg-base-300",
};

/**
 * Working directories and the per-session moderator toggle — and nothing else.
 *
 * Model and permission are deliberately absent: they are per tab and live only
 * in the composer, which is the note this section ends on.
 */
function SettingsSection(props: { project: Project }): JSX.Element {
  const { state, actions } = useWorkspace();
  const [adding, setAdding] = createSignal(false);
  const [path, setPath] = createSignal("");

  const moderatorDefault = () => state.settings?.moderator.enabled ?? true;

  async function addDir(): Promise<void> {
    const value = path().trim();
    if (!value) return;
    await actions.addDir(props.project.id, value);
    setPath("");
    setAdding(false);
  }

  return (
    <SectionPanel
      icon="sliders-horizontal"
      title="Settings"
      note={`· ${props.project.dirs.length} ${props.project.dirs.length === 1 ? "dir" : "dirs"}`}
      isOpen={prefs.panelSections.settings}
      onToggle={() => togglePanelSection("settings")}
      class="flex-none"
    >
      <div class="flex flex-col gap-2.5 px-3 pt-3 pb-3.5">
        <div class="text-[11.5px] text-az-muted">Working directories</div>

        <For each={props.project.dirs}>
          {(dir) => (
            <div class="flex min-w-0 items-center gap-2 rounded-[9px] border border-az-hairline-soft bg-base-300 px-2.5 py-[7px]">
              <Icon name="folder" class="shrink-0 text-[13px] text-primary/70" />
              <span class="min-w-0 flex-1 truncate font-mono text-[11.5px] text-az-body">
                {dir}
              </span>
              <button
                type="button"
                onClick={() => void actions.removeDir(props.project.id, dir)}
                aria-label={`Remove ${dir}`}
                class="shrink-0 text-az-faint transition-colors hover:text-error"
              >
                <Icon name="x" class="text-[13px]" />
              </button>
            </div>
          )}
        </For>

        <Show
          when={adding()}
          fallback={
            <button
              type="button"
              onClick={() => setAdding(true)}
              class="flex items-center gap-[7px] rounded-[9px] border border-primary/16 border-dashed px-2.5 py-[7px] text-[11.5px] text-az-muted transition-colors hover:border-primary hover:text-primary"
            >
              <Icon name="folder-plus" class="text-[13px]" />
              Add dir
            </button>
          }
        >
          {/*
            A typed path rather than a native folder picker: opening one needs
            the Tauri dialog plugin, which is not wired up on the Rust side yet.
          */}
          <input
            autofocus
            value={path()}
            placeholder="~/src/…"
            aria-label="Working directory path"
            onInput={(event) => setPath(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void addDir();
              if (event.key === "Escape") setAdding(false);
            }}
            onBlur={() => void addDir()}
            class="rounded-[9px] border border-primary/40 bg-base-300 px-2.5 py-[7px] font-mono text-[11.5px] text-az-body focus:outline-none"
          />
        </Show>

        <div class="my-0.5 h-px bg-az-hairline-soft" />

        <div class="flex items-center gap-2.5">
          <Icon name="shield" class="shrink-0 text-[14px] text-warning" />
          <span class="min-w-0 flex-1 text-[12px] text-az-body">
            Moderator
            <span class="mt-px block text-[11px] text-az-muted">
              this session · global default is {moderatorDefault() ? "on" : "off"}
            </span>
          </span>
          <Toggle
            aria-label="Moderator for this session"
            checked={props.project.moderatorEnabled}
            color="accent"
            size="sm"
            onChange={(event) =>
              void actions.setProjectModerator(props.project.id, event.currentTarget.checked)
            }
          />
        </div>

        <ApprovalRules projectId={props.project.id} />

        <div class="flex gap-[7px] pt-0.5 text-[11px] text-az-faint leading-[1.5]">
          <Icon name="info" class="relative top-0.5 shrink-0 text-[12px]" />
          Model and permission are per tab — set them in the composer. Everything else lives in
          global settings.
        </div>
      </div>
    </SectionPanel>
  );
}

/**
 * What "Always allow similar" has taught this project, and the way out.
 *
 * The rules are shown in full — an auto-allow the user cannot inspect is a
 * permission model on faith — and forgotten all at once: the list is short,
 * rules are one click to re-teach, and per-rule surgery can come when a real
 * list demands it. Hidden entirely while nothing is remembered.
 */
function ApprovalRules(props: { projectId: string }): JSX.Element {
  const { state, actions } = useWorkspace();
  const [rules, setRules] = createSignal<string[]>([]);

  // Re-asked when this project's pending approval appears or resolves — the
  // only moments a rule can be born; forgetting below updates the list itself.
  createEffect(() => {
    void state.pendingApprovals[props.projectId];
    void actions
      .listApprovalRules(props.projectId)
      .then(setRules)
      .catch(() => setRules([]));
  });

  const forget = (): void => {
    void actions
      .clearApprovalRules(props.projectId)
      .then(() => setRules([]))
      .catch((cause) => log.error(`could not clear the rules: ${describeError(cause)}`));
  };

  return (
    <Show when={rules().length > 0}>
      <div class="my-0.5 h-px bg-az-hairline-soft" />
      <div class="flex items-center gap-2">
        <span class="min-w-0 flex-1 text-[11.5px] text-az-muted">
          Remembered approvals · auto-allowed
        </span>
        <button
          type="button"
          onClick={forget}
          class="shrink-0 rounded-md border border-primary/16 px-2 py-0.5 text-[11px] text-az-body transition-colors hover:border-error hover:text-error"
        >
          Forget all
        </button>
      </div>
      <For each={rules()}>
        {(rule) => (
          <code class="block truncate rounded-md bg-base-300 px-2 py-1 font-mono text-[11px] text-az-body">
            {rule}
          </code>
        )}
      </For>
    </Show>
  );
}

function ItemList(props: { projectId: string; items: ProjectItem[] }): JSX.Element {
  const { state, actions } = useWorkspace();
  const [adding, setAdding] = createSignal(false);
  const [title, setTitle] = createSignal("");
  /*
   * Two heights, same contract as Agent I/O: capped by default so the other
   * sections keep the column, fully expanded on demand — a harvest that lands
   * a dozen items should be readable without a 300px porthole.
   */
  const [tall, setTall] = createSignal(false);
  /**
   * Narrows the list as you type. Substring, case-insensitive — the same rule
   * `wt-tools search-items` uses, so what you find here and what a query finds
   * from the terminal are the same set.
   *
   * Filtering hides rows rather than reordering them, and reorder is disabled
   * while a filter is on: dragging row 3 above row 1 means something different
   * when rows 2 and 4 are invisible.
   */
  const [query, setQuery] = createSignal("");
  const shown = () => {
    const needle = query().trim().toLowerCase();
    if (!needle) return props.items;
    return props.items.filter((item) => item.title.toLowerCase().includes(needle));
  };
  const filtering = () => query().trim().length > 0;

  /** The item whose title is being rewritten in place, if any. */
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editTitle, setEditTitle] = createSignal("");

  const saveEdit = async (item: ProjectItem): Promise<void> => {
    const value = editTitle().trim();
    setEditingId(null);
    if (!value || value === item.title) return;
    try {
      await actions.updateItem(item.id, value);
    } catch (cause) {
      log.error(`could not rename the item: ${describeError(cause)}`);
    }
  };

  async function create(): Promise<void> {
    const value = title().trim();
    if (value) await actions.createItem(props.projectId, value);
    setTitle("");
    setAdding(false);
  }

  /** Clicking an item cycles pending → active → finished → pending. */
  function advance(item: ProjectItem): void {
    const next =
      item.status === "pending" ? "active" : item.status === "active" ? "finished" : "pending";
    void actions.setItemStatus(item.id, next);
  }

  const isRunning = () => (state.running[props.projectId] ?? []).length > 0;

  /**
   * The flywheel closer: an item becomes a prompt on this project's own
   * session, so a harvested finding is one click from being worked instead of
   * being re-typed. The item is marked active in the same motion — the run
   * exists because of it, and the panel should say so.
   */
  function run(item: ProjectItem): void {
    void actions.setItemStatus(item.id, "active");
    void actions.send(
      props.projectId,
      `Work on this task from the project's item list:\n\n${item.title}\n\n` +
        `When you are done, say what changed and what is left, if anything. ` +
        `If the task is complete, end with this exact checklist line so the ` +
        `list updates itself:\n- [x] ${item.title}\n` +
        `If the task turns out to be obsolete rather than done, strike it ` +
        `instead:\n- [-] ${item.title}`,
    );
  }

  /**
   * Swap the item with its neighbour and persist the whole order. The full
   * id list goes over the wire because position is the index within it —
   * sending one move would make the backend re-derive what the panel
   * already knows.
   */
  function move(index: number, delta: number): void {
    const ordered = props.items.map((item) => item.id);
    const target = index + delta;
    if (target < 0 || target >= ordered.length) return;
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    void actions
      .reorderItems(props.projectId, ordered)
      .catch((cause) => log.error(`could not reorder: ${describeError(cause)}`));
  }

  return (
    <div
      class={`az-scroll flex flex-col gap-0.5 px-2 pt-1.5 pb-2.5 ${tall() ? "" : "max-h-[300px]"}`}
    >
      <Show when={props.items.length > 3}>
        <div class="flex items-center gap-2 rounded-[9px] border border-az-hairline bg-az-inset px-2.5 py-1.5">
          <Icon name="search" class="shrink-0 text-[12px] text-primary/70" />
          <input
            type="text"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder="Filter items…"
            aria-label="Filter items"
            class="min-w-0 flex-1 bg-transparent text-[12px] text-az-body outline-none placeholder:text-az-faint"
          />
          <Show when={filtering()}>
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear the filter"
              class="shrink-0 rounded-md p-0.5 text-az-faint transition-colors hover:text-az-body"
            >
              <Icon name="x" class="text-[11px]" />
            </button>
          </Show>
        </div>
      </Show>
      <Show when={filtering() && shown().length === 0}>
        <p class="px-2.5 py-3 text-[12px] text-az-muted">No item matches “{query().trim()}”.</p>
      </Show>
      <For each={shown()}>
        {(item, index) => (
          <Show
            when={editingId() !== item.id}
            fallback={
              <input
                autofocus
                value={editTitle()}
                aria-label={`Edit ${item.title}`}
                onInput={(event) => setEditTitle(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void saveEdit(item);
                  if (event.key === "Escape") setEditingId(null);
                }}
                onBlur={() => void saveEdit(item)}
                class="rounded-[9px] border border-primary/40 bg-base-300 px-2.5 py-2 text-[12.5px] text-az-body focus:outline-none"
              />
            }
          >
            <div
              class={`group flex items-center gap-1 rounded-[9px] pr-1 transition-colors ${
                item.status === "active"
                  ? "bg-base-300 shadow-[inset_2px_0_0_var(--color-primary)]"
                  : "hover:bg-white/5"
              }`}
            >
              {/*
               * The marker is the status control, and the only one.
               *
               * The whole row used to be a button titled "Change status", so
               * reading a list meant hovering a row that offered to mutate it
               * and clicking one by accident cycled it. A status change is a
               * deliberate act: it gets the smallest target that can carry it,
               * and the title beside it goes back to being text.
               */}
              <button
                type="button"
                onClick={() => advance(item)}
                aria-label={`Change the status of ${item.title}`}
                title={`${statusSuffix(item.status) || "pending"} — click to change`}
                class="ml-2.5 shrink-0 rounded-md p-0.5 transition-colors hover:bg-primary/12"
              >
                <Show
                  when={item.status === "finished"}
                  fallback={<ItemMarker status={item.status === "active" ? "active" : "pending"} />}
                >
                  <Icon name="check" class="relative top-0.5 shrink-0 text-[12px] text-success" />
                </Show>
              </button>
              <div
                data-selectable
                class="flex min-w-0 flex-1 items-baseline gap-2.5 px-2.5 py-2 text-left"
              >
                <span
                  class={`min-w-0 flex-1 text-[12.5px] ${
                    item.status === "active"
                      ? "text-base-content"
                      : item.status === "finished"
                        ? "text-az-muted"
                        : "text-az-body"
                  }`}
                >
                  {item.title}
                </span>
                <span
                  class={`shrink-0 text-[11px] ${
                    item.status === "active"
                      ? "font-semibold text-primary"
                      : item.status === "finished"
                        ? "text-success"
                        : "text-az-muted"
                  }`}
                >
                  {statusSuffix(item.status)}
                </span>
              </div>
              <Show when={item.status !== "finished"}>
                <button
                  type="button"
                  onClick={() => run(item)}
                  // Not gated on isLive: the mock serves sendMessage the same
                  // as the composer does, so the preview can exercise this.
                  disabled={isRunning()}
                  title={
                    isRunning()
                      ? "A run is already in flight on this project"
                      : "Send this item to the agent, on this project's session"
                  }
                  aria-label={`Run ${item.title}`}
                  class="shrink-0 rounded-md p-1 text-az-faint transition-colors hover:bg-primary/12 hover:text-primary disabled:opacity-30"
                >
                  <Icon name="play" class="text-[12px]" />
                </button>
              </Show>
              {/* Revealed on hover: the controls all the time would be louder
                than the titles they act on. */}
              <button
                type="button"
                onClick={() => {
                  setEditTitle(item.title);
                  setEditingId(item.id);
                }}
                aria-label={`Edit ${item.title}`}
                title="Edit this item"
                class="shrink-0 rounded-md p-1 text-az-faint opacity-0 transition-[color,opacity] hover:text-az-body group-hover:opacity-100"
              >
                <Icon name="pencil" class="text-[11px]" />
              </button>
              <button
                type="button"
                onClick={() =>
                  void actions
                    .deleteItem(item.id)
                    .catch((cause) =>
                      log.error(`could not delete the item: ${describeError(cause)}`),
                    )
                }
                aria-label={`Delete ${item.title}`}
                title="Delete this item"
                class="shrink-0 rounded-md p-1 text-az-faint opacity-0 transition-[color,opacity] hover:text-error group-hover:opacity-100"
              >
                <Icon name="x" class="text-[12px]" />
              </button>
              <div class="flex shrink-0 flex-col opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => move(index(), -1)}
                  disabled={filtering() || index() === 0}
                  aria-label={`Move ${item.title} up`}
                  class="rounded-sm px-0.5 text-az-faint transition-colors hover:text-az-body disabled:opacity-25"
                >
                  <Icon name="chevron-up" class="text-[10px]" />
                </button>
                <button
                  type="button"
                  onClick={() => move(index(), 1)}
                  disabled={filtering() || index() === props.items.length - 1}
                  aria-label={`Move ${item.title} down`}
                  class="rounded-sm px-0.5 text-az-faint transition-colors hover:text-az-body disabled:opacity-25"
                >
                  <Icon name="chevron-down" class="text-[10px]" />
                </button>
              </div>
            </div>
          </Show>
        )}
      </For>

      {/* Whenever the cap can be hiding anything: the 300px window fits about
          seven rows. A shorter list has nothing to expand, and the row would
          just be furniture. */}
      <Show when={props.items.length > 6}>
        <button
          type="button"
          onClick={() => setTall((open) => !open)}
          class="mt-0.5 rounded-md border border-az-hairline px-2 py-1 text-[10.5px] text-az-muted transition-colors hover:border-az-hairline-strong hover:text-base-content"
        >
          {tall() ? "Shrink the list" : `Show all ${props.items.length}`}
        </button>
      </Show>

      <Show
        when={adding()}
        fallback={
          <button
            type="button"
            onClick={() => setAdding(true)}
            class="mt-1 flex items-center gap-2 rounded-[9px] border border-primary/16 border-dashed px-2.5 py-2 text-[12px] text-az-muted transition-colors hover:border-primary hover:text-primary"
          >
            <Icon name="plus" class="text-[13px]" />
            New item
          </button>
        }
      >
        <input
          autofocus
          value={title()}
          placeholder="What needs doing?"
          aria-label="New item"
          onInput={(event) => setTitle(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void create();
            if (event.key === "Escape") setAdding(false);
          }}
          onBlur={() => void create()}
          class="mt-1 rounded-[9px] border border-primary/40 bg-base-300 px-2.5 py-2 text-[12px] text-az-body focus:outline-none"
        />
      </Show>
    </div>
  );
}

function RunningList(props: { projectId: string }): JSX.Element {
  const { state, actions, isLive } = useWorkspace();
  const now = useNow();
  const tasks = () => state.running[props.projectId] ?? [];

  return (
    <div class="az-scroll flex max-h-[230px] flex-col gap-2 px-3 pt-3 pb-3">
      <For each={tasks()}>
        {(task) => (
          <div class="rounded-[11px] border border-primary/22 bg-base-300 px-3 py-2.5">
            <div class="truncate font-mono text-[12px] text-az-strong">{task.label}</div>
            <div class="mt-2 flex items-center gap-2 text-[11px]">
              <span class="font-mono text-az-muted">{task.name}</span>
              <span class="text-primary">{elapsed(task.startedAt, now())}</span>
              <div class="flex-1" />
              <button
                type="button"
                /*
                 * `isLive` too: per-tool cancellation has no Rust side yet,
                 * so on the real backend this routes to the mock — which
                 * fakes a `task:completed` while the tool keeps running.
                 * Greyed out until it can be true, per the house convention.
                 */
                disabled={!task.isCancelable || !task.toolCallId || !isLive("cancelTask")}
                onClick={() => task.toolCallId && void actions.cancelTask(task.toolCallId)}
                class="rounded-md border border-primary/16 px-2 py-0.5 text-az-body transition-colors hover:border-error hover:text-error disabled:opacity-40"
              >
                Stop
              </button>
            </div>
          </div>
        )}
      </For>

      <Show when={tasks().length === 0}>
        <p class="rounded-[11px] border border-primary/12 border-dashed p-3 text-center text-[11.5px] text-az-muted">
          Nothing running
        </p>
      </Show>
    </div>
  );
}

function TaskLogList(props: { projectId: string }): JSX.Element {
  const { state } = useWorkspace();
  const entries = () => state.taskLog[props.projectId] ?? [];

  return (
    /*
     * Capped and scrolling, `data-selectable` throughout: a long run's log
     * used to grow the whole right column instead of scrolling itself, and
     * the global `user-select: none` made its rows uncopyable. Whole-log
     * export is the Copy button in the section header.
     */
    <div
      data-selectable
      class="az-scroll flex max-h-[45vh] min-h-0 flex-1 flex-col gap-[7px] px-3 pt-2.5 pb-3"
    >
      <For each={entries()}>
        {(entry) => (
          /*
           * Three states, not two. `ok` is `boolean | null`, and null means the
           * agent did not report an outcome — which is not failure. Rendering
           * it with the error mark would tell you a tool failed when nothing
           * said so.
           */
          <div class="flex items-baseline gap-2 text-[11.5px]">
            <Icon
              name={entry.ok === true ? "check" : entry.ok === false ? "x" : "info"}
              label={entry.ok === null ? "Outcome not reported" : undefined}
              class={`shrink-0 text-[12px] ${
                entry.ok === true
                  ? "text-success"
                  : entry.ok === false
                    ? "text-error"
                    : "text-az-muted"
              }`}
            />
            <span class="min-w-0 flex-1 truncate text-az-body" title={entry.label}>
              {entry.label}
            </span>
            <span class={`shrink-0 ${entry.ok === false ? "text-error" : "text-az-muted"}`}>
              {taskMeta(entry)}
            </span>
          </div>
        )}
      </For>

      <Show when={entries().length === 0}>
        <p class="py-3 text-center text-[11.5px] text-az-muted">Nothing has run yet</p>
      </Show>
    </div>
  );
}

/** The whole visible log as text: outcome, label, meta — one line per entry. */
function CopyLogButton(props: { projectId: string }): JSX.Element {
  const { state } = useWorkspace();
  const copy = async (): Promise<void> => {
    const text = (state.taskLog[props.projectId] ?? [])
      .map(
        (entry) =>
          `${entry.ok === true ? "ok" : entry.ok === false ? "FAILED" : "?"} ${entry.label} · ${taskMeta(entry)}`,
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch (cause) {
      log.warn(`could not copy the task log: ${describeError(cause)}`);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      class="shrink-0 text-[11px] text-az-faint transition-colors hover:text-base-content"
    >
      Copy
    </button>
  );
}

function ClearLogButton(props: { projectId: string }): JSX.Element {
  const { actions } = useWorkspace();
  return (
    <button
      type="button"
      onClick={() => void actions.clearTaskLog(props.projectId)}
      class="shrink-0 text-[11px] text-az-faint transition-colors hover:text-base-content"
    >
      Clear
    </button>
  );
}
