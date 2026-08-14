import { Checkbox, Input, Slider, Switch, Textarea } from "@pathscale/ui";
import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { NOTES_BUDGET } from "~/api/client";
import { AppModal, type ModalAnchor } from "~/components/AppModal";
import { Button } from "~/components/Button";
import { Icon } from "~/components/Icon";
import { SectionPanel } from "~/components/Panel";
import { PillMenu } from "~/components/PillMenu";
import { ItemMarker } from "~/components/StatusDot";
import { copyText } from "~/features/project/MessageBody";
import { clockTime, elapsed, taskMeta } from "~/lib/format";
import { defaultItemDescription } from "~/lib/itemDescription";
import { sortItems } from "~/lib/itemSort";
import { nextStatus, statusLabel, statusSuffix } from "~/lib/labels";
import { describeError, log } from "~/lib/log";
import { tx } from "~/stores/i18n";
import { prefs, setPrefs, togglePanelSection } from "~/stores/prefs";
import { useNow, useWorkspace } from "~/stores/workspace";
import type { Agent, Project, ProjectItem, Question, RunningTask } from "~/types";

export const PROJECT_ITEM_PAGE_SIZE = 12;

export function itemPage<T>(items: readonly T[], limit: number): T[] {
  return items.slice(0, Math.max(0, limit));
}

/**
 * The project's right-hand column: Items · Running · Task log · Agent I/O ·
 * Settings.
 *
 * This replaced the old left sidebar. Open state lives in `UiPrefs`, per
 * install rather than per project, so the panel you left open stays open when
 * you switch tabs.
 */
export function ProjectPanel(props: { project: Project; agent: Agent }): JSX.Element {
  const { state, itemsFor, openItemCount } = useWorkspace();

  const running = () => state.running[props.project.id] ?? [];
  const log = () => state.taskLog[props.project.id] ?? [];
  const io = () => state.agentIo[props.project.id] ?? [];
  const panelItems = createMemo(() => {
    const visible = itemsFor(props.project.id);
    const archivedForkAnchors = (state.items[props.project.id] ?? []).filter(
      (item) =>
        item.archived && state.projects.some((project) => project.forkedFrom?.itemId === item.id),
    );
    const reveal = state.itemReveal?.id;
    const archived = reveal
      ? (state.items[props.project.id] ?? []).find((item) => item.id === reveal && item.archived)
      : undefined;
    const nested = [...visible, ...archivedForkAnchors];
    if (archived && !nested.some((item) => item.id === archived.id)) nested.push(archived);
    return nested.sort((a, b) => a.order - b.order);
  });

  return (
    <div class="az-scroll flex h-full min-h-0 w-[332px] flex-none flex-col gap-2.5 overflow-y-auto overscroll-contain">
      <SectionPanel
        icon="list-checks"
        title={tx("Items")}
        count={openItemCount(props.project.id)}
        lead={<ItemSortControls />}
        isOpen={prefs.panelSections.items}
        onToggle={() => togglePanelSection("items")}
        class={
          prefs.panelSections.items
            ? "flex max-h-[48vh] min-h-[52px] flex-none flex-col"
            : "flex-none"
        }
        contentClass="flex min-h-0 flex-1 flex-col"
      >
        <ItemList projectId={props.project.id} items={panelItems()} />
      </SectionPanel>

      <SectionPanel
        title={tx("Running")}
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
        title={tx("Task log")}
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
        title={tx("Agent I/O")}
        count={io().length}
        isOpen={prefs.panelSections.io}
        onToggle={() => togglePanelSection("io")}
        class={prefs.panelSections.io ? "flex min-h-[160px] flex-col" : "flex-none"}
      >
        <AgentIoList projectId={props.project.id} />
      </SectionPanel>

      <SectionPanel
        icon="sparkles"
        title={tx("Kept across compaction")}
        isOpen={prefs.panelSections.notes}
        onToggle={() => togglePanelSection("notes")}
        class="flex-none"
      >
        <NotesEditor projectId={props.project.id} />
      </SectionPanel>

      {/* Last, deliberately: directories and the moderator toggle are set once
          and revisited rarely, and they were costing the working sections the
          top of the column. */}
      <SettingsSection project={props.project} agent={props.agent} />
    </div>
  );
}

/** Two small toggles produce Status/Time × ascending/descending. */
function ItemSortControls(): JSX.Element {
  return (
    <fieldset
      class="m-0 flex min-w-0 shrink-0 items-center gap-1 border-0 p-0"
      aria-label={tx("Sort items")}
    >
      <Button
        type="button"
        onClick={() => setPrefs("itemSortBy", prefs.itemSortBy === "status" ? "time" : "status")}
        class="rounded-md border border-az-hairline bg-az-inset px-1.5 py-0.5 font-medium text-[10.5px] text-az-muted transition-colors hover:text-az-strong"
        title={tx("Toggle item sort between status and time")}
      >
        {tx(prefs.itemSortBy === "status" ? "Status" : "Time")}
      </Button>
      <Button
        type="button"
        onClick={() =>
          setPrefs("itemSortDirection", prefs.itemSortDirection === "asc" ? "desc" : "asc")
        }
        class="flex size-5 items-center justify-center rounded-md border border-az-hairline bg-az-inset text-az-muted transition-colors hover:text-az-strong"
        aria-label={tx(prefs.itemSortDirection === "asc" ? "Sort descending" : "Sort ascending")}
        title={tx(prefs.itemSortDirection === "asc" ? "Ascending" : "Descending")}
      >
        <Icon
          name="arrow-up"
          class={`text-[11px] transition-transform ${prefs.itemSortDirection === "desc" ? "rotate-180" : ""}`}
        />
      </Button>
    </fieldset>
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
    <Checkbox
      checked={enabled()}
      state={!isLive("setIoPersist") ? "disabled" : undefined}
      onChange={(event) => void toggle(event.currentTarget.checked)}
      title={tx(
        "Keep this project's raw exchange in the database, so it survives a restart. Off by default: a long run writes thousands of rows.",
      )}
      class="px-3.5 py-2 text-[11px] text-az-muted [&_[data-slot=checkbox-control]]:size-4"
    >
      {tx("Keep across restarts")}
    </Checkbox>
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
            {tx("Nothing sent yet on this project.")}
          </p>
        }
      >
        <div class="flex flex-none items-center gap-1.5 px-2.5 pb-1.5">
          <Button
            type="button"
            onClick={() => setTall((open) => !open)}
            class="rounded-md border border-az-hairline px-2 py-0.5 text-[10.5px] text-az-muted transition-colors hover:border-az-hairline-strong hover:text-base-content"
          >
            {tall() ? tx("Shrink") : tx("Expand")}
          </Button>
          <Button
            type="button"
            onClick={() => void copyAll()}
            class="rounded-md border border-az-hairline px-2 py-0.5 text-[10.5px] text-az-muted transition-colors hover:border-az-hairline-strong hover:text-base-content"
          >
            {tx("Copy all")}
          </Button>
          <span class="ml-auto text-[10.5px] text-az-faint">
            {lines().length} {tx("entries")}
          </span>
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
function SettingsSection(props: { project: Project; agent: Agent }): JSX.Element {
  const { state, actions, isLive } = useWorkspace();
  const [adding, setAdding] = createSignal(false);
  const [path, setPath] = createSignal("");

  const moderatorDefault = () => state.settings?.moderator.enabled ?? true;
  const isRunning = () => (state.running[props.project.id] ?? []).length > 0;

  /** The native panel, then straight into the list: no second confirmation. */
  async function pick(): Promise<void> {
    try {
      const picked = await actions.chooseProjectDirectory();
      if (picked) {
        await actions.addDir(props.project.id, picked);
        setAdding(false);
        setPath("");
      }
    } catch (cause) {
      log.error(`could not choose a directory: ${describeError(cause)}`);
    }
  }

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
      title={tx("Settings")}
      note={`· ${props.project.dirs.length} ${
        props.project.dirs.length === 1 ? tx("dir") : tx("dirs")
      }`}
      isOpen={prefs.panelSections.settings}
      onToggle={() => togglePanelSection("settings")}
      class="flex-none"
    >
      <div class="flex flex-col gap-2.5 px-3 pt-3 pb-3.5">
        <div class="text-[11.5px] text-az-muted">{tx("Working directories")}</div>

        <For each={props.project.dirs}>
          {(dir) => (
            <div class="flex min-w-0 items-center gap-2 rounded-[9px] border border-az-hairline-soft bg-base-300 px-2.5 py-[7px]">
              <Icon name="folder" class="shrink-0 text-[13px] text-primary/70" />
              <span class="min-w-0 flex-1 truncate font-mono text-[11.5px] text-az-body">
                {dir}
              </span>
              <Button
                type="button"
                onClick={() => void actions.removeDir(props.project.id, dir)}
                aria-label={tx("Remove {name}", { name: dir })}
                class="shrink-0 text-az-faint transition-colors hover:text-error"
              >
                <Icon name="x" class="text-[13px]" />
              </Button>
            </div>
          )}
        </For>

        <Show
          when={adding()}
          fallback={
            <Button
              type="button"
              onClick={() => setAdding(true)}
              class="flex items-center gap-[7px] rounded-[9px] border border-primary/16 border-dashed px-2.5 py-[7px] text-[11.5px] text-az-muted transition-colors hover:border-primary hover:text-primary"
            >
              <Icon name="folder-plus" class="text-[13px]" />
              {tx("Add dir")}
            </Button>
          }
        >
          {/*
            Type a path or pick one. The picker matters more than it looks: a
            typed path is how a project ends up pointed at a directory that is
            not a checkout, and a project with no checkout can have no pull
            requests discovered for it, silently.
          */}
          <div class="flex items-center gap-1.5">
            <Button
              type="button"
              onClick={() => void pick()}
              disabled={!isLive("chooseProjectDirectory")}
              aria-label={tx("Choose a working directory")}
              title={tx("Choose a folder")}
              class="shrink-0 cursor-pointer rounded-[9px] border border-primary/40 px-2 py-[7px] text-az-body transition-colors hover:border-primary hover:text-primary disabled:opacity-40"
            >
              <Icon name="folder-plus" class="text-[13px]" />
            </Button>
            <Input.Field
              autofocus
              value={path()}
              placeholder={tx("~/src/…")}
              aria-label={tx("Working directory path")}
              onInput={(event) => setPath(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addDir();
                if (event.key === "Escape") setAdding(false);
              }}
              onBlur={() => void addDir()}
              class="min-w-0 flex-1 rounded-[9px] border border-primary/40 bg-base-300 px-2.5 py-[7px] font-mono text-[11.5px] text-az-body focus:outline-none"
            />
          </div>
        </Show>

        <div class="my-0.5 h-px bg-az-hairline-soft" />

        <div class="flex items-center gap-2.5">
          <Icon name="shield" class="shrink-0 text-[14px] text-warning" />
          <span class="min-w-0 flex-1 text-[12px] text-az-body">
            {tx("Moderator")}
            <span class="mt-px block text-[11px] text-az-muted">
              {tx("this session · global default is")} {moderatorDefault() ? tx("on") : tx("off")}
            </span>
          </span>
          <Switch
            aria-label={tx("Moderator for this session")}
            checked={props.project.moderatorEnabled}
            flavor="accent"
            size="sm"
            onChange={(event) =>
              void actions.setProjectModerator(props.project.id, event.currentTarget.checked)
            }
          />
        </div>

        <div class="my-0.5 h-px bg-az-hairline-soft" />

        <ConciseResponseToggle projectId={props.project.id} />

        <div class="my-0.5 h-px bg-az-hairline-soft" />

        <ContextDetailSelect projectId={props.project.id} />

        <div class="my-0.5 h-px bg-az-hairline-soft" />

        <CheckpointToggle projectId={props.project.id} />

        <ApprovalRules projectId={props.project.id} />

        <ResetSession project={props.project} running={isRunning()} />

        <div class="my-0.5 h-px bg-az-hairline-soft" />

        <ResumeSession
          projectId={props.project.id}
          agent={props.agent}
          running={isRunning()}
          currentSession={
            props.agent === "claude"
              ? (props.project.sessions.claude ?? props.project.sessionId)
              : props.project.sessions[props.agent]
          }
        />

        <div class="flex gap-[7px] pt-0.5 text-[11px] text-az-faint leading-[1.5]">
          <Icon name="info" class="relative top-0.5 shrink-0 text-[12px]" />
          {tx(
            "Model and permission are per tab — set them in the composer. Everything else lives in global settings.",
          )}
        </div>
      </div>
    </SectionPanel>
  );
}

/** Project response verbosity, stored in KV and added to every turn. */
function ConciseResponseToggle(props: { projectId: string }): JSX.Element {
  const { actions, isLive } = useWorkspace();
  const levels = ["default", "low", "medium", "high"] as const;
  const labels = () => [tx("Model default"), tx("Low"), tx("Medium"), tx("High")];
  const hints = () => [
    tx("Use the model's default response detail"),
    tx("Keep responses concise"),
    tx("Balance detail and brevity"),
    tx("Include more detail in responses"),
  ];
  const [level, setLevel] = createSignal<(typeof levels)[number]>("default");

  createEffect(() => {
    const id = props.projectId;
    void actions
      .getProjectConcise(id)
      .then((value) =>
        setLevel(
          levels.includes(value as (typeof levels)[number])
            ? (value as (typeof levels)[number])
            : "default",
        ),
      )
      .catch((cause) => log.warn(`could not read response verbosity: ${describeError(cause)}`));
  });

  const choose = async (index: number): Promise<void> => {
    const previous = level();
    const next = levels[index] ?? "default";
    setLevel(next);
    try {
      await actions.setProjectConcise(props.projectId, next);
    } catch (cause) {
      setLevel(previous);
      log.error(`could not change response verbosity: ${describeError(cause)}`);
    }
  };
  const index = () => levels.indexOf(level());

  return (
    <div class="flex items-start gap-2.5">
      <Icon name="message-square-dashed" class="shrink-0 text-[14px] text-primary/75" />
      <div class="min-w-0 flex-1">
        <div class="flex items-center justify-between text-[12px] text-az-body">
          <span>{tx("Verbosity")}</span>
          <span class="font-medium text-primary">{labels()[index()]}</span>
        </div>
        <Slider
          label={tx("Response verbosity for this project")}
          min={0}
          max={3}
          step={1}
          value={index()}
          disabled={!isLive("setProjectConcise")}
          onChange={(value) => void choose(value)}
          // The chosen label is already printed above the track.
          formatValue={(value) => labels()[value] ?? labels()[0]}
          size="sm"
          class="mt-1 [&_[data-slot=label]]:sr-only [&_[data-slot=slider-output]]:sr-only"
        />
        <span class="mt-1 block text-[10.5px] text-az-muted">{hints()[index()]}</span>
      </div>
    </div>
  );
}

/**
 * How much per-turn context this project re-sends, stored in KV.
 *
 * The open-items + PR snapshot rides every user turn and is the biggest
 * recurring input cost on a busy project. "Compact" drops item titles and
 * references (the agent already saw them when they were created); "Minimal"
 * sends only a count and a pointer to `agency-tools list-items`. This is the
 * input-side companion to Concise responses, which trims the output.
 */
function ContextDetailSelect(props: { projectId: string }): JSX.Element {
  const { actions, isLive } = useWorkspace();
  const [level, setLevel] = createSignal("adaptive");

  createEffect(() => {
    const id = props.projectId;
    void actions
      .getProjectVerbosity(id)
      .then(setLevel)
      .catch((cause) => log.warn(`could not read context detail: ${describeError(cause)}`));
  });

  const choose = async (next: string): Promise<void> => {
    const previous = level();
    setLevel(next);
    try {
      await actions.setProjectVerbosity(props.projectId, next);
    } catch (cause) {
      setLevel(previous);
      log.error(`could not change context detail: ${describeError(cause)}`);
    }
  };

  return (
    <div class="flex items-center gap-2.5">
      <Icon name="list-checks" class="shrink-0 text-[14px] text-primary/75" />
      <span class="min-w-0 flex-1 text-[12px] text-az-body">
        {tx("Context detail")}
        <span class="mt-px block text-[11px] text-az-muted">
          {tx("How much of the item list rides every turn — less means fewer tokens")}
        </span>
      </span>
      <PillMenu
        label={tx("Per-turn context detail for this project")}
        variant="outline"
        value={level()}
        isDisabled={!isLive("setProjectVerbosity")}
        options={[
          {
            value: "adaptive",
            label: tx("Auto"),
            hint: tx("Full after changes or a fresh session; compact while unchanged"),
          },
          {
            value: "full",
            label: tx("Full"),
            hint: tx("Every open item with title and reference"),
          },
          {
            value: "compact",
            label: tx("Compact"),
            hint: tx("Item ids and status only, no titles"),
          },
          {
            value: "minimal",
            label: tx("Minimal"),
            hint: tx("Just a count and where to fetch the list"),
          },
        ]}
        onChange={(value) => void choose(value)}
      />
    </div>
  );
}

/**
 * The recovery path for a wedged conversation: forget the resume pointer so the
 * next message starts fresh, keeping the transcript.
 *
 * When a run is killed for going idle the session id survives so the next turn
 * resumes — right for a transient stall, wrong when the session itself is the
 * problem (a Codex thread that re-enters the same dead wait on resume). This is
 * the way out that is not "delete the project". Two-step, because it breaks
 * conversation continuity; hidden until there is a session to reset; disabled
 * while a run is live (the backend refuses then too).
 */
function ResetSession(props: { project: Project; running: boolean }): JSX.Element {
  const { actions } = useWorkspace();
  const [confirming, setConfirming] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  /**
   * The last reset failure, shown inline. It used to go only to the log: a
   * reset refused because a wedged run still held the project's run slot looked
   * exactly like a button that did nothing, and "reset does not work" had no
   * visible cause. If the slot is stuck, the message says to force-cancel.
   */
  const [error, setError] = createSignal("");

  const agents = (): string[] =>
    Object.entries(props.project.sessions ?? {})
      .filter(([, id]) => Boolean(id))
      .map(([agent]) => agent);

  const reset = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      // Every agent that has a session on this project, so a project that ran
      // both providers is fully reset rather than half.
      /*
       * Confirmation is authoritative even when the window's running signal is
       * stale. That stale split is the recovery case: Rust still owns a slot,
       * while the webview no longer shows a run. Always allow the confirmed
       * reset to evict such a slot, and clear provider sessions in sequence so
       * only one call can own the eviction.
       */
      for (const agent of agents()) {
        await actions.resetProjectSession(props.project.id, agent, true);
      }
      setConfirming(false);
    } catch (cause) {
      const detail = describeError(cause);
      log.error(`could not reset the session: ${detail}`);
      setError(detail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={agents().length > 0}>
      <div class="flex flex-col gap-1.5">
        <div class="flex items-center gap-2.5">
          <Icon name="history" class="shrink-0 text-[14px] text-primary/75" />
          <span class="min-w-0 flex-1 text-[12px] text-az-body">
            {tx("Reset session")}
            <span class="mt-px block text-[11px] text-az-muted">
              {props.running
                ? tx(
                    "A run is stuck — force-reset clears the slot and starts the next message fresh",
                  )
                : tx("Start the next message fresh — the recovery path for a wedged conversation")}
            </span>
          </span>
          {/*
            Never disabled while running. A wedged run is the whole reason to
            reset: it holds the project's run slot with no live process to
            cancel, so a greyed Reset was a dead end that read as "reset does not
            work". Running turns the button into an explicit Force reset instead.
          */}
          <Show
            when={confirming()}
            fallback={
              <Button
                type="button"
                class={`btn btn-xs text-[11px] ${props.running ? "btn-error" : "border-az-hairline bg-base-100"}`}
                onClick={() => setConfirming(true)}
              >
                {props.running ? tx("Force reset") : tx("Reset")}
              </Button>
            }
          >
            <div class="flex items-center gap-1.5">
              <Button
                type="button"
                class="btn btn-xs btn-error text-[11px]"
                disabled={busy()}
                onClick={() => void reset()}
              >
                {props.running ? tx("Confirm force reset") : tx("Confirm reset")}
              </Button>
              <Button
                type="button"
                class="btn btn-xs btn-ghost text-[11px]"
                disabled={busy()}
                onClick={() => setConfirming(false)}
              >
                {tx("Cancel")}
              </Button>
            </div>
          </Show>
        </div>
        <Show when={error()}>
          <p role="alert" class="pl-[26px] text-[11px] text-error">
            {tx("Could not reset:")} {error()}
          </p>
        </Show>
      </div>
    </Show>
  );
}

/**
 * Adopt an existing session by id, so the next message on this project resumes
 * it. The way back to a wedged conversation that lives on disk but the project
 * lost track of — e.g. a Codex thread recovered by its id with `codex resume`.
 *
 * Always available (unlike Reset, which needs a current session): the whole
 * point is to attach a session when the project has none, or a different one.
 * Disabled while a run is live, which the backend also refuses.
 */
function ResumeSession(props: {
  projectId: string;
  agent: string;
  running: boolean;
  currentSession?: string | null;
}): JSX.Element {
  const { actions } = useWorkspace();
  const [open, setOpen] = createSignal(false);
  const [id, setId] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const adopt = async (): Promise<void> => {
    const sessionId = id().trim();
    if (!sessionId) return;
    setBusy(true);
    try {
      await actions.adoptSession(props.projectId, props.agent, sessionId);
      setOpen(false);
      setId("");
    } catch (cause) {
      log.error(`could not adopt the session: ${describeError(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex items-center gap-2.5">
        <Icon name="history" class="shrink-0 text-[14px] text-primary/75" />
        <span class="min-w-0 flex-1 text-[12px] text-az-body">
          {tx("Resume a session by id")}
          <span class="mt-px block text-[11px] text-az-muted">
            {props.currentSession
              ? tx("Attached: {session}", { session: props.currentSession })
              : tx("Attach a session recovered by its id so the next message continues it")}
          </span>
        </span>
        <Button
          type="button"
          class="btn btn-xs border-az-hairline bg-base-100 text-[11px]"
          disabled={props.running}
          title={props.running ? tx("Cancel the active run first") : undefined}
          onClick={() => setOpen((value) => !value)}
        >
          {tx(props.currentSession ? "Change" : "Resume")}
        </Button>
      </div>
      <Show when={open()}>
        <div class="flex items-center gap-1.5 pl-[26px]">
          <Input.Field
            value={id()}
            placeholder={tx("session id, e.g. 019fc95e-…")}
            onInput={(event) => setId(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void adopt();
              if (event.key === "Escape") setOpen(false);
            }}
            class="min-w-0 flex-1 rounded-md border border-az-hairline bg-base-300 px-2 py-1 font-mono text-[11px] text-az-body focus:outline-none"
          />
          <Button
            type="button"
            class="btn btn-xs btn-primary text-[11px]"
            disabled={busy() || props.running || !id().trim()}
            onClick={() => void adopt()}
          >
            {tx("Attach")}
          </Button>
        </div>
      </Show>
    </div>
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
          {tx("Remembered approvals · auto-allowed")}
        </span>
        <Button
          type="button"
          onClick={forget}
          class="shrink-0 rounded-md border border-primary/16 px-2 py-0.5 text-[11px] text-az-body transition-colors hover:border-error hover:text-error"
        >
          {tx("Forget all")}
        </Button>
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
  const [forkingId, setForkingId] = createSignal<string | null>(null);
  // Where the control that opened the dialog was, so it lands beside the row
  // it is about rather than in the middle of the window.
  const [contextAnchor, setContextAnchor] = createSignal<ModalAnchor | null>(null);
  const [contextDraft, setContextDraft] = createSignal<{
    item: ProjectItem;
    context: string;
    startFork: boolean;
  } | null>(null);
  const [descriptionDraft, setDescriptionDraft] = createSignal<{
    item: ProjectItem;
    context: string;
    saved: string;
  } | null>(null);
  const [savingDescriptionId, setSavingDescriptionId] = createSignal<string | null>(null);
  const forkFor = (itemId: string) =>
    state.projects.find((project) => project.forkedFrom?.itemId === itemId);
  /**
   * The pull request a shipped row names, when this project has one by that
   * number. The item stores the number alone, deliberately: it is the match
   * key's neighbour, not a URL to be kept in sync with a repository rename.
   * The URL is looked up from the project's own pull requests instead.
   */
  const prUrl = (reference: string) =>
    (state.pullRequests[props.projectId] ?? []).find((pr) => String(pr.number) === reference)?.url;
  const issueUrl = (reference: string) =>
    reference.startsWith("issue:") ? reference.slice("issue:".length) : null;
  const issueNumber = (url: string) => url.split("/").at(-1) ?? "?";
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
  const [itemLimit, setItemLimit] = createSignal(PROJECT_ITEM_PAGE_SIZE);
  const [hoveredItemId, setHoveredItemId] = createSignal<string | null>(null);
  const [focusedItemId, setFocusedItemId] = createSignal<string | null>(null);
  const shown = createMemo(() => {
    const needle = query().trim().toLowerCase();
    const items = needle
      ? props.items.filter((item) => item.title.toLowerCase().includes(needle))
      : props.items;
    return sortItems(items, prefs.itemSortBy, prefs.itemSortDirection);
  });
  const visibleShown = createMemo(() => itemPage(shown(), itemLimit()));
  const filtering = () => query().trim().length > 0;

  createEffect(() => {
    const target = state.itemReveal;
    target?.revision;
    if (!target || !props.items.some((item) => item.id === target.id)) return;
    setQuery("");
    const targetIndex = shown().findIndex((item) => item.id === target.id);
    if (targetIndex >= 0) {
      setItemLimit((limit) => Math.max(limit, targetIndex + 1));
    }
    queueMicrotask(() => {
      const row = document.querySelector<HTMLElement>(`[data-item-id="${target.id}"]`);
      row?.scrollIntoView?.();
      row?.focus();
    });
  });

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

  /*
   * The ladder lives in `lib/labels` now, because Home had its own and the
   * same click on the same row did different things on the two screens.
   *
   * The click cycle stays on visible working states so a row cannot disappear
   * by surprise. Terminal states remain reachable through explicit actions and
   * the agent authoring surface.
   */
  function advance(item: ProjectItem): void {
    void actions.setItemStatus(item.id, nextStatus(item.status));
  }

  const isRunning = () => (state.running[props.projectId] ?? []).length > 0;

  /**
   * Prefer an unanswered question, but keep the newest dismissed one reachable.
   * Dismiss closes the inline card; it must not strand an item whose workflow
   * status still says the owner owes it a reply.
   */
  function questionFor(item: ProjectItem): Question | undefined {
    return [...(state.questions[props.projectId] ?? [])]
      .filter((question) => question.itemId === item.id)
      .sort((left, right) => {
        if (left.answered !== right.answered) return left.answered ? 1 : -1;
        return right.createdAt === left.createdAt
          ? right.id.localeCompare(left.id)
          : right.createdAt.localeCompare(left.createdAt);
      })[0];
  }

  function replyTo(question: Question): void {
    actions.selectQuestionReply(question.projectId, question.id);
  }

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
      undefined,
      undefined,
      item.id,
    );
  }

  function openFork(item: ProjectItem): void {
    const existing = forkFor(item.id);
    if (existing) {
      actions.openProject(existing.id);
      return;
    }
    const fallback = defaultItemDescription(item);
    setContextDraft({ item, context: fallback, startFork: true });
    void actions
      .getItemContext(item.id)
      .then((context) => {
        const current = contextDraft();
        // A delayed load must not overwrite text the owner has already typed.
        if (current?.item.id === item.id && current.context === fallback) {
          setContextDraft({ item, context: context || fallback, startFork: true });
        }
      })
      .catch((cause) => log.error(`could not load the item context: ${describeError(cause)}`));
  }

  async function toggleDescription(item: ProjectItem): Promise<void> {
    if (descriptionDraft()?.item.id === item.id) {
      setDescriptionDraft(null);
      return;
    }
    try {
      const context = await actions.getItemContext(item.id);
      setDescriptionDraft({ item, context, saved: context });
    } catch (cause) {
      log.error(`could not load the item description: ${describeError(cause)}`);
    }
  }

  async function saveDescription(): Promise<void> {
    const draft = descriptionDraft();
    if (!draft) return;
    setSavingDescriptionId(draft.item.id);
    try {
      const saved = await actions.setItemContext(draft.item.id, draft.context);
      setDescriptionDraft({ ...draft, context: saved, saved });
    } catch (cause) {
      log.error(`could not save the item description: ${describeError(cause)}`);
    } finally {
      setSavingDescriptionId(null);
    }
  }

  async function saveContext(): Promise<void> {
    const draft = contextDraft();
    if (!draft) return;
    setForkingId(draft.item.id);
    try {
      if (draft.startFork) {
        try {
          await actions.setItemContext(draft.item.id, draft.context);
        } catch (cause) {
          log.error(`could not save the fork context: ${describeError(cause)}`);
        }
        await actions.forkItem(draft.item.id);
      } else {
        await actions.setItemContext(draft.item.id, draft.context);
      }
      setContextDraft(null);
    } catch (cause) {
      log.error(`could not save the item description: ${describeError(cause)}`);
    } finally {
      setForkingId(null);
    }
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
      data-item-list
      class="az-scroll flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-2 pt-1.5 pb-2.5"
    >
      <Show when={props.items.length > 3}>
        <div class="mb-1 flex items-center gap-2 border-az-hairline-soft border-b bg-az-inset px-2.5 py-1.5">
          <Icon name="search" class="shrink-0 text-[12px] text-primary/70" />
          <Input.Field
            type="text"
            value={query()}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setItemLimit(PROJECT_ITEM_PAGE_SIZE);
            }}
            placeholder={tx("Filter items…")}
            aria-label={tx("Filter items")}
            class="min-w-0 flex-1 bg-transparent text-[12px] text-az-body outline-none placeholder:text-az-faint"
          />
          <Show when={filtering()}>
            <Button
              type="button"
              onClick={() => {
                setQuery("");
                setItemLimit(PROJECT_ITEM_PAGE_SIZE);
              }}
              aria-label={tx("Clear the filter")}
              class="shrink-0 rounded-md p-0.5 text-az-faint transition-colors hover:text-az-body"
            >
              <Icon name="x" class="text-[11px]" />
            </Button>
          </Show>
        </div>
      </Show>
      <Show when={filtering() && shown().length === 0}>
        <p class="px-2.5 py-3 text-[12px] text-az-muted">
          {tx("No item matches “{query}”", { query: query().trim() })}
        </p>
      </Show>
      <For each={visibleShown()}>
        {(item, index) => (
          <Show
            when={editingId() !== item.id}
            fallback={
              <Input.Field
                autofocus
                value={editTitle()}
                aria-label={tx("Edit {name}", { name: item.title })}
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
            <div class="rounded-[9px]">
              <div
                data-item-id={item.id}
                tabIndex={-1}
                onPointerEnter={() => setHoveredItemId(item.id)}
                onPointerLeave={() => setHoveredItemId(null)}
                onFocusIn={() => {
                  setFocusedItemId(item.id);
                  if (descriptionDraft() && descriptionDraft()?.item.id !== item.id) {
                    setDescriptionDraft(null);
                  }
                }}
                onFocusOut={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setFocusedItemId(null);
                  }
                }}
                /*
                 * The row is `relative` and the action cluster below is absolute,
                 * so the buttons take ZERO layout width. They used to be a normal
                 * flex sibling: even at opacity-0 they held ~120px of a 322px
                 * column, so every title wrapped into a four-word ribbon. Now the
                 * title owns the whole width and the controls float over its right
                 * end only on hover.
                 */
                class={`group relative flex items-center outline-none transition-colors ${
                  descriptionDraft()?.item.id === item.id ? "rounded-t-[9px]" : "rounded-[9px]"
                } ${
                  state.itemReveal?.id === item.id
                    ? "ring-1 ring-primary/70 ring-offset-1 ring-offset-base-200"
                    : ""
                } ${item.archived ? "border border-primary/18 border-dashed opacity-75" : ""} ${
                  item.status === "active"
                    ? "bg-base-300 shadow-[inset_2px_0_0_var(--color-primary)]"
                    : // Zebra striping so a long list reads row by row; the hover
                      // still lifts on top of whichever stripe is underneath. The
                      // odd stripe is deliberately not faint: barely-visible
                      // striping reads as a rendering smudge, not a pattern.
                      index() % 2 === 1
                      ? "bg-white/[0.055] hover:bg-white/[0.08]"
                      : "hover:bg-white/5"
                }`}
              >
                <div class="flex min-w-0 flex-1 items-center gap-1">
                  {/*
                   * The marker is the status control, and the only one.
                   *
                   * The whole row used to be a button titled "Change status", so
                   * reading a list meant hovering a row that offered to mutate it
                   * and clicking one by accident cycled it. A status change is a
                   * deliberate act: it gets the smallest target that can carry it,
                   * and the title beside it goes back to being text.
                   */}
                  <Button
                    type="button"
                    onClick={() => advance(item)}
                    aria-label={tx("Change the status of {name}", { name: item.title })}
                    title={`${statusSuffix(item.status)} — click for ${statusLabel(nextStatus(item.status))}`}
                    class="ml-1.5 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-primary/12 focus-visible:bg-primary/12"
                  >
                    <ItemMarker status={item.status} />
                  </Button>
                  <div class="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left">
                    <span
                      data-selectable
                      title={item.title}
                      class={`line-clamp-2 min-w-0 flex-1 text-[12.5px] leading-[1.35] ${
                        item.status === "active" || item.status === "planning"
                          ? "text-base-content"
                          : item.status === "finished"
                            ? "text-az-muted"
                            : "text-az-body"
                      }`}
                    >
                      {item.title}
                    </span>
                    <span
                      class={`flex shrink-0 flex-col items-end text-[10.5px] leading-[1.2] ${
                        item.status === "active"
                          ? "font-semibold text-primary"
                          : item.status === "shipped"
                            ? "font-semibold text-warning"
                            : item.status === "planning"
                              ? "text-info"
                              : item.status === "finished"
                                ? "text-success"
                                : "text-az-muted"
                      }`}
                    >
                      {/*
                    Status is never replaced by its reference. A shipped row
                    needs both facts: what state the work claims and which PR
                    the owner should inspect. The wider panel lets those stack
                    without taking another column from the title.
                  */}
                      <span>{item.archived ? tx("archived") : statusSuffix(item.status)}</span>
                      <Show when={item.reference}>
                        {(reference) => (
                          <Show
                            when={issueUrl(reference())}
                            fallback={
                              /*
                        And it opens. The number is there to be checked, so
                        reading it and then going to find the pull request by
                        hand is the one thing it should not cost. Plain text
                        when the project has no pull request by that number,
                        rather than a link that goes nowhere.
                      */
                              <Show
                                when={prUrl(reference())}
                                fallback={
                                  <>
                                    {tx("(PR #")}
                                    {reference()})
                                  </>
                                }
                              >
                                {(url) => (
                                  <Button
                                    type="button"
                                    onClick={() => void actions.openExternal(url())}
                                    title={tx("Open {url}", { url: url() })}
                                    class="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-primary"
                                  >
                                    {tx("(PR #")}
                                    {reference()})
                                  </Button>
                                )}
                              </Show>
                            }
                          >
                            {(url) => (
                              <Button
                                type="button"
                                onClick={() => void actions.openExternal(url())}
                                title={tx("Open {url}", { url: url() })}
                                class="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-primary"
                              >
                                {tx("(issue #")}
                                {issueNumber(url())})
                              </Button>
                            )}
                          </Show>
                        )}
                      </Show>
                    </span>
                  </div>
                </div>
                <Button
                  type="button"
                  onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    setContextAnchor({
                      left: box.left,
                      top: box.top,
                      right: box.right,
                      bottom: box.bottom,
                    });
                    void toggleDescription(item);
                  }}
                  title={tx("Description / sub-items")}
                  aria-label={tx("Edit the description for {name}", { name: item.title })}
                  aria-expanded={descriptionDraft()?.item.id === item.id}
                  aria-controls={`item-description-${item.id}`}
                  /*
                    These action buttons are plain siblings in the row, so
                    without a margin their 1px borders meet and read as one
                    segmented control rather than three separate targets. The
                    row cannot carry a `gap` instead: it also holds the title
                    and the status label, which want the wider spacing.
                  */
                  class={`relative ml-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-md border transition-colors hover:border-primary/70 hover:bg-primary/20 ${
                    descriptionDraft()?.item.id === item.id || item.context?.trim()
                      ? "border-primary/45 bg-primary/14 text-primary"
                      : "border-primary/20 bg-primary/5 text-az-muted"
                  }`}
                >
                  <Icon name="list-checks" class="text-[13px]" />
                </Button>
                <Button
                  type="button"
                  onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    setContextAnchor({
                      left: box.left,
                      top: box.top,
                      right: box.right,
                      bottom: box.bottom,
                    });
                    openFork(item);
                  }}
                  disabled={forkingId() === item.id}
                  title={
                    forkFor(item.id)
                      ? tx("Open this item's lower-token fork")
                      : tx("Start a fresh fork to avoid resending this project's long chat")
                  }
                  aria-label={
                    forkFor(item.id)
                      ? tx("Open the fork for {name}", { name: item.title })
                      : tx("Fork {name} into a fresh chat", { name: item.title })
                  }
                  class={`relative ml-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-md border transition-colors hover:border-primary/70 hover:bg-primary/20 disabled:opacity-30 ${
                    forkFor(item.id)
                      ? "border-primary/55 bg-primary/18 text-primary"
                      : "border-primary/30 bg-primary/8 text-primary/80"
                  } ${item.status === "questions" ? "" : "mr-1"}`}
                >
                  <Icon name="git-fork" class="text-[13px]" />
                </Button>
                <Show when={item.status === "questions"}>
                  <Show
                    when={questionFor(item)}
                    fallback={
                      <Button
                        type="button"
                        onClick={() => run(item)}
                        disabled={isRunning()}
                        title={
                          isRunning()
                            ? tx("A run is already in flight on this project")
                            : tx("No unanswered question — work on this item")
                        }
                        aria-label={tx("Work on {name}; it has no unanswered question", {
                          name: item.title,
                        })}
                        class="relative z-10 mr-1 ml-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-md border border-primary/55 bg-primary/18 text-primary transition-colors hover:border-primary hover:bg-primary/28 disabled:opacity-30"
                      >
                        <Icon name="play" class="text-[11px]" />
                      </Button>
                    }
                  >
                    {(question) => (
                      <Button
                        type="button"
                        onClick={() => replyTo(question())}
                        title={tx("Reply to this item's question")}
                        aria-label={tx("Reply to the question for {name}", { name: item.title })}
                        class="relative z-10 mr-1 ml-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-md border border-warning/65 bg-warning/22 text-warning shadow-[0_0_0_1px_rgb(from_var(--color-warning)_r_g_b/.08)] transition-colors hover:border-warning hover:bg-warning/34 focus-visible:border-warning focus-visible:bg-warning/34"
                      >
                        <Icon name="message-square-dashed" class="text-[12px]" />
                      </Button>
                    )}
                  </Show>
                </Show>
                {/*
                 * Absolutely positioned over the row's right end, only ink when
                 * hovered or busy. Out of the layout flow entirely so the title
                 * gets the full column width; a translucent gradient underlay
                 * keeps the icons legible where they overlap a long title. These
                 * act on the row, they are not part of reading it.
                 */}
                <Show when={hoveredItemId() === item.id || focusedItemId() === item.id}>
                  <div
                    class={`absolute inset-y-0 flex items-center justify-end gap-1 rounded-r-[9px] bg-gradient-to-l from-60% from-base-300 to-transparent pr-2 pl-6 ${
                      item.status === "questions" ? "right-[74px]" : "right-[50px]"
                    }`}
                  >
                    <Show when={item.status !== "finished"}>
                      <Button
                        type="button"
                        onClick={() => {
                          const question = questionFor(item);
                          if (question) replyTo(question);
                          else run(item);
                        }}
                        // Not gated on isLive: the mock serves sendMessage the same
                        // as the composer does, so the preview can exercise this.
                        disabled={!questionFor(item) && isRunning()}
                        title={
                          questionFor(item)
                            ? tx("Reply to this item's question")
                            : isRunning()
                              ? tx("A run is already in flight on this project")
                              : tx("Send this item to the agent, on this project's session")
                        }
                        aria-label={
                          questionFor(item)
                            ? tx("Reply to the question for {name}", { name: item.title })
                            : tx("Run {name}", { name: item.title })
                        }
                        class={`shrink-0 rounded-md border p-1 transition-colors disabled:opacity-30 ${
                          questionFor(item)
                            ? "border-warning/55 bg-warning/18 text-warning hover:border-warning hover:bg-warning/30"
                            : "border-transparent text-az-faint hover:border-primary/25 hover:bg-primary/12 hover:text-primary"
                        }`}
                      >
                        <Icon
                          name={questionFor(item) ? "message-square-dashed" : "play"}
                          class="text-[12px]"
                        />
                      </Button>
                    </Show>
                    {/* Revealed on hover: the controls all the time would be louder
                than the titles they act on. */}
                    <Button
                      type="button"
                      onClick={() => {
                        const current = issueUrl(item.reference ?? "") ?? "";
                        const url = window.prompt(tx("GitHub issue URL"), current)?.trim();
                        if (!url) return;
                        void actions
                          .setItemIssue(item.id, url)
                          .catch((cause) =>
                            log.error(`could not link the issue: ${describeError(cause)}`),
                          );
                      }}
                      aria-label={tx("Link a GitHub issue to {name}", { name: item.title })}
                      title={tx("Link a GitHub issue")}
                      class="shrink-0 rounded-md p-1 text-az-faint transition-colors hover:text-primary"
                    >
                      <Icon name="git-pull-request" class="text-[11px]" />
                    </Button>
                    <Button
                      type="button"
                      onClick={() => {
                        setEditTitle(item.title);
                        setEditingId(item.id);
                      }}
                      aria-label={tx("Edit {name}", { name: item.title })}
                      title={tx("Edit this item")}
                      class="shrink-0 rounded-md p-1 text-az-faint transition-colors hover:text-az-body"
                    >
                      <Icon name="pencil" class="text-[11px]" />
                    </Button>
                    <Button
                      type="button"
                      onClick={() =>
                        void actions
                          .deleteItem(item.id)
                          .catch((cause) =>
                            log.error(`could not delete the item: ${describeError(cause)}`),
                          )
                      }
                      aria-label={tx("Delete {name}", { name: item.title })}
                      title={tx("Delete this item")}
                      class="shrink-0 rounded-md p-1 text-az-faint transition-colors hover:text-error"
                    >
                      <Icon name="x" class="text-[12px]" />
                    </Button>
                    <div class="flex shrink-0 flex-col">
                      <Button
                        type="button"
                        onClick={() => move(index(), -1)}
                        disabled={filtering() || index() === 0}
                        aria-label={tx("Move {name} up", { name: item.title })}
                        class="rounded-sm px-0.5 text-az-faint transition-colors hover:text-az-body disabled:opacity-25"
                      >
                        <Icon name="chevron-up" class="text-[10px]" />
                      </Button>
                      <Button
                        type="button"
                        onClick={() => move(index(), 1)}
                        disabled={filtering() || index() === props.items.length - 1}
                        aria-label={tx("Move {name} down", { name: item.title })}
                        class="rounded-sm px-0.5 text-az-faint transition-colors hover:text-az-body disabled:opacity-25"
                      >
                        <Icon name="chevron-down" class="text-[10px]" />
                      </Button>
                    </div>
                  </div>
                </Show>
              </div>
              <Show when={descriptionDraft()?.item.id === item.id ? descriptionDraft() : null}>
                {(draft) => (
                  <section
                    id={`item-description-${item.id}`}
                    class="flex flex-col gap-2 rounded-b-[9px] border-primary/24 border-t bg-az-inset px-3 py-2.5 shadow-[inset_2px_0_0_color-mix(in_srgb,var(--color-primary)_55%,transparent)]"
                  >
                    <div class="flex items-center justify-between gap-3">
                      <span class="font-semibold text-[11.5px] text-az-body">
                        {tx("Description / sub-items")}
                      </span>
                      <span class="font-mono text-[10px] text-az-faint">
                        {draft().context.length} / {NOTES_BUDGET}
                      </span>
                    </div>
                    <Textarea
                      autofocus
                      value={draft().context}
                      maxLength={NOTES_BUDGET}
                      onInput={(event) =>
                        setDescriptionDraft({ ...draft(), context: event.currentTarget.value })
                      }
                      aria-label={tx("Description / sub-items")}
                      placeholder={tx(
                        "Describe constraints, acceptance criteria, decisions, and useful pointers…",
                      )}
                      class="az-scroll min-h-[138px] resize-y rounded-lg border border-primary/22 bg-base-300 px-3 py-2.5 text-[12px] text-az-body leading-[1.5] outline-none placeholder:text-az-faint focus:border-primary/55"
                    />
                    <div class="flex items-center justify-between gap-3">
                      <span class="text-[10.5px] text-az-muted">
                        {tx("Use one Markdown bullet or checklist line per sub-item.")}
                      </span>
                      <div class="flex shrink-0 items-center gap-1.5">
                        <Button
                          type="button"
                          onClick={() => setDescriptionDraft(null)}
                          class="rounded-md px-2.5 py-1 text-[11px] text-az-muted hover:bg-white/6 hover:text-az-body"
                        >
                          {tx("Close")}
                        </Button>
                        <Button
                          type="button"
                          disabled={
                            savingDescriptionId() === item.id || draft().context === draft().saved
                          }
                          onClick={() => void saveDescription()}
                          class="rounded-md border border-primary/40 bg-primary/15 px-2.5 py-1 font-semibold text-[11px] text-primary hover:bg-primary/24 disabled:opacity-35"
                        >
                          {tx("Save description")}
                        </Button>
                      </div>
                    </div>
                  </section>
                )}
              </Show>
            </div>
          </Show>
        )}
      </For>
      <Show when={shown().length > visibleShown().length}>
        <Button
          type="button"
          onClick={() => setItemLimit((limit) => limit + PROJECT_ITEM_PAGE_SIZE)}
          class="mt-1 flex-none rounded-[9px] border border-primary/24 bg-primary/8 px-2.5 py-2 font-semibold text-[11.5px] text-primary transition-colors hover:bg-primary/14"
        >
          {tx("Show {count} more items", {
            count: Math.min(PROJECT_ITEM_PAGE_SIZE, shown().length - visibleShown().length),
          })}
        </Button>
      </Show>

      <Show
        when={adding()}
        fallback={
          <Button
            type="button"
            onClick={() => setAdding(true)}
            class="mt-1 flex items-center gap-2 rounded-[9px] border border-primary/16 border-dashed px-2.5 py-2 text-[12px] text-az-muted transition-colors hover:border-primary hover:text-primary"
          >
            <Icon name="plus" class="text-[13px]" />
            {tx("New item")}
          </Button>
        }
      >
        <Input.Field
          autofocus
          value={title()}
          placeholder={tx("What needs doing?")}
          aria-label={tx("New item")}
          onInput={(event) => setTitle(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void create();
            if (event.key === "Escape") setAdding(false);
          }}
          onBlur={() => void create()}
          class="mt-1 rounded-[9px] border border-primary/40 bg-base-300 px-2.5 py-2 text-[12px] text-az-body focus:outline-none"
        />
      </Show>

      <Show when={contextDraft()}>
        {(draft) => (
          <AppModal
            labelledBy="item-context-title"
            anchor={contextAnchor()}
            onDismiss={() => setContextDraft(null)}
          >
            {/*
              A plain hairline, not `az-ring`. That class paints a
              primary-tinted gradient across the whole panel rather than only
              its edge, which washed the header in olive.
            */}
            <section class="flex max-h-full w-[560px] max-w-full flex-none flex-col overflow-hidden rounded-[14px] border border-az-hairline-strong bg-base-200 shadow-[0_24px_80px_rgba(0,0,0,.65)]">
              <header class="flex items-start gap-3 border-az-hairline-soft border-b px-5 py-4">
                <div class="flex size-9 shrink-0 items-center justify-center rounded-[11px] border border-primary/28 bg-primary/10 text-primary">
                  <Icon name="git-fork" class="text-[17px]" />
                </div>
                <div class="min-w-0 flex-1">
                  <h2 id="item-context-title" class="font-semibold text-[14.5px] text-az-title">
                    {draft().startFork ? tx("Prepare item fork") : tx("Edit item description")}
                  </h2>
                  <p class="mt-0.5 truncate text-[12px] text-az-muted">{draft().item.title}</p>
                </div>
                <Button
                  type="button"
                  onClick={() => setContextDraft(null)}
                  aria-label={tx("Cancel")}
                  class="rounded-lg p-1.5 text-az-muted hover:bg-white/6 hover:text-base-content"
                >
                  <Icon name="x" class="text-[15px]" />
                </Button>
              </header>
              <div class="flex min-h-0 flex-col gap-2 px-5 py-4">
                <div class="flex items-center justify-between gap-3">
                  <label for="item-description" class="font-semibold text-[12.5px] text-az-body">
                    {tx("Description / sub-items")}
                  </label>
                  <span class="font-mono text-[10.5px] text-az-faint">
                    {draft().context.length} / {NOTES_BUDGET}
                  </span>
                </div>
                <Textarea
                  id="item-description"
                  autofocus
                  value={draft().context}
                  maxLength={NOTES_BUDGET}
                  onInput={(event) =>
                    setContextDraft({
                      item: draft().item,
                      context: event.currentTarget.value,
                      startFork: draft().startFork,
                    })
                  }
                  placeholder={tx(
                    "Describe constraints, acceptance criteria, decisions, and useful pointers…",
                  )}
                  class="az-scroll min-h-[220px] resize-y rounded-xl border border-primary/24 bg-az-inset px-3.5 py-3 text-[12.5px] text-az-body leading-[1.55] outline-none placeholder:text-az-faint focus:border-primary/55"
                />
                <p class="text-[11px] text-az-muted leading-[1.5]">
                  {tx(
                    "Sent when this item starts in a fresh fork or focused run. Ordinary compact item snapshots omit it.",
                  )}{" "}
                  {tx("Use one Markdown bullet or checklist line per sub-item.")}
                </p>
              </div>
              <footer class="flex items-center justify-end gap-2 border-az-hairline-soft border-t px-5 py-3.5">
                <Button
                  type="button"
                  onClick={() => setContextDraft(null)}
                  class="rounded-lg border border-az-hairline px-3 py-1.5 text-[12px] text-az-body hover:border-primary/35"
                >
                  {tx("Cancel")}
                </Button>
                <Button
                  type="button"
                  disabled={forkingId() === draft().item.id}
                  onClick={() => void saveContext()}
                  class="rounded-lg border border-primary/45 bg-primary/18 px-3 py-1.5 font-semibold text-[12px] text-primary hover:bg-primary/25 disabled:opacity-40"
                >
                  {draft().startFork ? tx("Start fork") : tx("Save description")}
                </Button>
              </footer>
            </section>
          </AppModal>
        )}
      </Show>
    </div>
  );
}

function RunningList(props: { projectId: string }): JSX.Element {
  const { state } = useWorkspace();
  const now = useNow();
  const tasks = () => state.running[props.projectId] ?? [];

  return (
    <div class="az-scroll flex max-h-[230px] flex-col gap-2 px-3 pt-3 pb-3">
      <For each={tasks()}>{(task) => <RunningTaskCard task={task} now={now()} />}</For>

      <Show when={tasks().length === 0}>
        <p class="rounded-[11px] border border-primary/12 border-dashed p-3 text-center text-[11.5px] text-az-muted">
          {tx("Nothing running")}
        </p>
      </Show>
    </div>
  );
}

export function RunningTaskCard(props: { task: RunningTask; now: number }): JSX.Element {
  const { actions, isLive } = useWorkspace();

  return (
    <div class="rounded-[11px] border border-primary/22 bg-base-300 px-3 py-2.5">
      {/* A running row is the present, so show the whole command rather than a
          truncated label that hides what the provider is actually doing. */}
      <div class="whitespace-pre-wrap break-words font-mono text-[12px] text-az-strong">
        {props.task.label}
      </div>
      <div class="mt-2 flex items-center gap-2 text-[11px]">
        <span class="font-mono text-az-muted">{props.task.name}</span>
        <span class="text-primary">{elapsed(props.task.startedAt, props.now)}</span>
        <div class="flex-1" />
        <Button
          type="button"
          disabled={!props.task.isCancelable || !isLive("cancelRun")}
          onClick={() => void actions.cancelRun(props.task.projectId)}
          class="rounded-md border border-primary/16 px-2 py-0.5 text-az-body transition-colors hover:border-error hover:text-error disabled:opacity-40"
        >
          {tx("Stop")}
        </Button>
      </div>
    </div>
  );
}

function TaskLogList(props: { projectId: string }): JSX.Element {
  const { state } = useWorkspace();
  const entries = () => state.taskLog[props.projectId] ?? [];
  /** The one entry showing its whole command, if any. */
  const [expanded, setExpanded] = createSignal<string | null>(null);
  /** The row whose copy action most recently succeeded. */
  const [copied, setCopied] = createSignal<string | null>(null);

  const copyEntry = async (id: string, text: string): Promise<void> => {
    if (!(await copyText(text))) return;
    setCopied(id);
    window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1_400);
  };

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
          <div class="flex flex-col gap-1 text-[11.5px]">
            <div class="flex items-baseline gap-2">
              <Icon
                name={entry.ok === true ? "check" : entry.ok === false ? "x" : "info"}
                label={entry.ok === null ? tx("Outcome not reported") : undefined}
                class={`shrink-0 text-[12px] ${
                  entry.ok === true
                    ? "text-success"
                    : entry.ok === false
                      ? "text-error"
                      : "text-az-muted"
                }`}
              />
              {/*
               * Expands in place rather than truncating for good. A task log
               * entry *is* the command, and a command cut at the panel's width
               * (for example, "…gh run rerun \"$ID\" --failed 2>&1 | t") cannot be read,
               * checked or copied, which is the whole reason to keep a log.
               * The title attribute was the only way to see the rest, and a
               * tooltip cannot be selected.
               */}
              {/*
               * The verb, which the label alone does not carry. A row reading
               * `Cargo.toml` says a file was involved and nothing about what
               * happened to it: read, searched, written and stat'd all look
               * identical. The tool name was already on the row's data and
               * simply was not rendered.
               */}
              <span class="shrink-0 font-mono text-[11px] text-az-muted">{entry.tool}</span>
              {/*
               * `aria-label` rather than `title`: the tooltip fired on hover
               * over every row on the way past, which reads as the panel
               * flinching. The pointer already says the row is a control.
               */}
              <Button
                type="button"
                onClick={() => setExpanded(expanded() === entry.id ? null : entry.id)}
                aria-label={expanded() === entry.id ? tx("Collapse") : tx("Show the whole command")}
                class={`min-w-0 flex-1 cursor-pointer text-left text-az-body ${
                  expanded() === entry.id ? "whitespace-pre-wrap break-all" : "truncate"
                }`}
              >
                <span data-selectable>{entry.label}</span>
              </Button>
              <span class={`shrink-0 ${entry.ok === false ? "text-error" : "text-az-muted"}`}>
                {taskMeta(entry)}
              </span>
              <Button
                type="button"
                onClick={() =>
                  void copyEntry(
                    entry.id,
                    [`${entry.tool} ${entry.label}`, entry.output].filter(Boolean).join("\n\n"),
                  )
                }
                aria-label={tx("Copy this task-log entry")}
                title={copied() === entry.id ? tx("Copied") : tx("Copy")}
                class="shrink-0 rounded p-0.5 text-az-faint transition-colors hover:text-az-body"
              >
                <Icon name={copied() === entry.id ? "check" : "copy"} class="text-[11px]" />
              </Button>
            </div>
            <Show when={expanded() === entry.id && entry.output}>
              <pre class="az-scroll max-h-64 whitespace-pre-wrap break-words rounded-md border border-az-hairline bg-az-inset px-2 py-1.5 font-mono text-[10.5px] text-az-body">
                {entry.output}
              </pre>
            </Show>
          </div>
        )}
      </For>

      <Show when={entries().length === 0}>
        <p class="py-3 text-center text-[11.5px] text-az-muted">{tx("Nothing has run yet")}</p>
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
    <Button
      type="button"
      onClick={() => void copy()}
      class="shrink-0 text-[11px] text-az-faint transition-colors hover:text-base-content"
    >
      {tx("Copy")}
    </Button>
  );
}

/**
 * Sample the agent's knowledge as the context fills, to find out where
 * compacting should happen.
 *
 * An experiment rather than a feature, and the description says so, because a
 * switch whose only effect is three extra billed turns needs to explain itself
 * before it is flipped. Nothing reads the samples back to the agent; they are
 * evidence for a question nobody can answer from first principles — does the
 * pre-compaction extraction get *worse* as the conversation it summarises gets
 * bigger?
 */
function CheckpointToggle(props: { projectId: string }): JSX.Element {
  const { actions, isLive } = useWorkspace();
  const [enabled, setEnabled] = createSignal(false);

  createEffect(() => {
    const id = props.projectId;
    void actions
      .getCheckpoints(id)
      .then(setEnabled)
      .catch((cause) => log.warn(`could not read the checkpoint setting: ${describeError(cause)}`));
  });

  const toggle = async (next: boolean): Promise<void> => {
    setEnabled(next);
    try {
      await actions.setCheckpoints(props.projectId, next);
    } catch (cause) {
      // Put it back: the control must not claim a setting that did not save.
      setEnabled(!next);
      log.error(`could not change knowledge checkpoints: ${describeError(cause)}`);
    }
  };

  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex items-center gap-2.5">
        <Icon name="history" class="shrink-0 text-[14px] text-az-muted" />
        <span class="min-w-0 flex-1 text-[12px] text-az-body">
          {tx("Knowledge checkpoints")}
          <span class="mt-px block text-[11px] text-az-muted">
            {tx("this project · off by default")}
          </span>
        </span>
        <Switch
          aria-label={tx("Knowledge checkpoints for this project")}
          checked={enabled()}
          flavor="accent"
          size="sm"
          disabled={!isLive("setCheckpoints")}
          onChange={(event) => void toggle(event.currentTarget.checked)}
        />
      </div>
      {/*
        Spelled out rather than left to a tooltip. This one costs money on a
        schedule the user does not control, so what it does, when it fires and
        what it is for all have to be readable before the switch is flipped.
      */}
      <p class="pl-[26px] text-[11px] text-az-faint leading-[1.5]">
        {tx(
          "As this conversation grows past 300k, 600k and 900k tokens, run the same note-taking pass a compaction would and save the result to a file — one extra turn each time, billed like any other. The agent never sees these; they exist so the three can be compared to find out whether the notes get worse under pressure, and where compacting is actually best done. Files land beside the database in checkpoints/, and the marks re-arm after every compaction.",
        )}
      </p>
    </div>
  );
}

/**
 * What the agent kept when the conversation was summarised — and the only place
 * it can be corrected.
 *
 * These notes are standing instructions: they ride every turn and the model
 * treats them as true. That is the point of them, and also the risk. An agent
 * that misread a correction, or generalised a one-off into a rule, would carry
 * it for the life of the project, and the only symptom would be behaviour with
 * no visible cause. Durable memory nobody can inspect is a liability; this
 * section is what makes it a feature.
 *
 * Editable rather than merely visible, for the same reason. Seeing a wrong rule
 * and having no way to strike it out would be its own kind of maddening.
 */
function NotesEditor(props: { projectId: string }): JSX.Element {
  const { actions, isLive } = useWorkspace();
  const [draft, setDraft] = createSignal("");
  const [saved, setSaved] = createSignal("");
  const [status, setStatus] = createSignal<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = createSignal("");

  // Re-read when the tab changes under a reused instance, and after a
  // compaction has had a chance to write.
  createEffect(() => {
    const projectId = props.projectId;
    void actions
      .getProjectNotes(projectId)
      .then((notes) => {
        setDraft(notes);
        setSaved(notes);
      })
      .catch((cause) => log.warn(`could not read the notes: ${describeError(cause)}`));
  });

  const dirty = () => draft() !== saved();
  const remaining = () => NOTES_BUDGET - draft().length;

  const save = async (next: string): Promise<void> => {
    setStatus("saving");
    try {
      // The stored text comes back clamped, so what is on screen after a save
      // is what the agent will actually be told.
      const kept = await actions.setProjectNotes(props.projectId, next);
      setDraft(kept);
      setSaved(kept);
      setStatus("idle");
      setMessage("");
    } catch (cause) {
      setStatus("error");
      setMessage(describeError(cause));
    }
  };

  return (
    <div class="flex flex-col gap-2 p-3">
      <p class="text-[11.5px] text-az-muted leading-[1.5]">
        {tx(
          "Written by the agent before each compaction and sent with every turn since. Correct anything wrong here — it is being followed.",
        )}
      </p>

      {/*
        Always an editor, never an empty state.

        An empty box with a placeholder can be *typed into*, which a "nothing
        kept yet" panel cannot — and seeding the rules by hand before the first
        compaction is worth having on its own. Waiting for a compaction to earn
        the right to state a house rule would be an odd thing to enforce.
      */}
      <Textarea
        value={draft()}
        onInput={(event) => setDraft(event.currentTarget.value)}
        rows={8}
        aria-label={tx("Notes kept across compaction")}
        placeholder={tx(
          "Nothing kept yet — the first /compact fills this in.\n\nYou can also write rules here yourself; they are sent with every turn either way.",
        )}
        disabled={!isLive("setProjectNotes")}
        class="az-scroll w-full resize-y rounded-lg border border-az-hairline-strong bg-base-300 p-2.5 font-mono text-[11.5px] text-az-body leading-[1.6] placeholder:text-az-faint focus:border-primary/40 focus:outline-none disabled:opacity-50"
      />
      <div class="flex items-center gap-2">
        <span
          class={`text-[11px] ${remaining() < 0 ? "text-error" : "text-az-faint"}`}
          title={tx(
            "The budget is {budget} characters; anything over is dropped from the top when saved.",
            { budget: NOTES_BUDGET },
          )}
        >
          {remaining() < 0
            ? tx("{count} over — the oldest lines will be dropped", { count: -remaining() })
            : tx("{count} left", { count: remaining() })}
        </span>
        <div class="flex-1" />
        <Show when={dirty()}>
          <Button
            type="button"
            onClick={() => setDraft(saved())}
            class="shrink-0 text-[11px] text-az-faint transition-colors hover:text-base-content"
          >
            {tx("Revert")}
          </Button>
        </Show>
        {/*
         * Saving is a state, not a different label. The library draws the
         * spinner and sets `aria-busy` from `state`, which is what 2.2 wants,
         * and it keeps the caption static.
         *
         * Static matters beyond taste here. A reactive expression placed
         * directly inside a Layout component updates once and then freezes,
         * because the compiler's `children` is a memo built on first read and
         * owned by whichever effect reads it first, which disposes it when it
         * re-runs. This button swapped "Save" for "Saving…" on click and never
         * swapped back, so the caption lied and nothing could find the control
         * again. See section 8 of SOLID-LAYOUTS-ISSUES.md.
         */}
        <Button
          type="button"
          onClick={() => void save(draft())}
          state={status() === "saving" ? "loading" : undefined}
          disabled={!dirty() || status() === "saving" || !isLive("setProjectNotes")}
          class="shrink-0 rounded-lg border border-primary/18 px-2.5 py-[3px] text-[11.5px] text-az-body transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          {tx("Save")}
        </Button>
        {/* Forgetting on purpose is a real thing to want: a project that
              changed direction is better off with nothing than with rules
              written for the work it used to be doing. */}
        <Button
          type="button"
          onClick={() => void save("")}
          disabled={!saved().trim() || !isLive("setProjectNotes")}
          class="shrink-0 text-[11px] text-az-faint transition-colors hover:text-error disabled:cursor-not-allowed disabled:opacity-40"
        >
          {tx("Forget")}
        </Button>
      </div>

      <Show when={status() === "error"}>
        <p role="alert" class="text-[11.5px] text-error">
          {tx("Could not save — what you typed is still here.")} {message()}
        </p>
      </Show>
    </div>
  );
}

function ClearLogButton(props: { projectId: string }): JSX.Element {
  const { actions } = useWorkspace();
  return (
    <Button
      type="button"
      onClick={() => void actions.clearTaskLog(props.projectId)}
      class="shrink-0 text-[11px] text-az-faint transition-colors hover:text-base-content"
    >
      {tx("Clear")}
    </Button>
  );
}
