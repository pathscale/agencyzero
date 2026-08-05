import { Toggle } from "@pathscale/ui";
import { createEffect, createSignal, For, type JSX, Show } from "solid-js";
import { NOTES_BUDGET } from "~/api/client";
import { Icon } from "~/components/Icon";
import { SectionPanel } from "~/components/Panel";
import { PillMenu } from "~/components/PillMenu";
import { ItemMarker } from "~/components/StatusDot";
import { copyText } from "~/features/project/MessageBody";
import { clockTime, elapsed, taskMeta } from "~/lib/format";
import { nextStatus, statusLabel, statusSuffix } from "~/lib/labels";
import { describeError, log } from "~/lib/log";
import { tx } from "~/stores/i18n";
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
    <div class="az-scroll flex min-h-0 w-[322px] flex-none flex-col gap-2.5">
      <SectionPanel
        icon="list-checks"
        title={tx("Items")}
        count={openItemCount(props.project.id)}
        isOpen={prefs.panelSections.items}
        onToggle={() => togglePanelSection("items")}
        class={prefs.panelSections.items ? "flex min-h-0 flex-1 flex-col" : "flex-none"}
        contentClass="flex min-h-0 flex-1 flex-col"
      >
        <ItemList projectId={props.project.id} items={itemsFor(props.project.id)} />
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
      title={tx(
        "Keep this project's raw exchange in the database, so it survives a restart. Off by default: a long run writes thousands of rows.",
      )}
    >
      <input
        type="checkbox"
        checked={enabled()}
        disabled={!isLive("setIoPersist")}
        onChange={(event) => void toggle(event.currentTarget.checked)}
        class="size-3 accent-primary"
      />
      {tx("Keep across restarts")}
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
            {tx("Nothing sent yet on this project.")}
          </p>
        }
      >
        <div class="flex flex-none items-center gap-1.5 px-2.5 pb-1.5">
          <button
            type="button"
            onClick={() => setTall((open) => !open)}
            class="rounded-md border border-az-hairline px-2 py-0.5 text-[10.5px] text-az-muted transition-colors hover:border-az-hairline-strong hover:text-base-content"
          >
            {tall() ? tx("Shrink") : tx("Expand")}
          </button>
          <button
            type="button"
            onClick={() => void copyAll()}
            class="rounded-md border border-az-hairline px-2 py-0.5 text-[10.5px] text-az-muted transition-colors hover:border-az-hairline-strong hover:text-base-content"
          >
            {tx("Copy all")}
          </button>
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
function SettingsSection(props: { project: Project }): JSX.Element {
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
              <button
                type="button"
                onClick={() => void actions.removeDir(props.project.id, dir)}
                aria-label={tx("Remove {name}", { name: dir })}
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
              {tx("Add dir")}
            </button>
          }
        >
          {/*
            Type a path or pick one. The picker matters more than it looks: a
            typed path is how a project ends up pointed at a directory that is
            not a checkout, and a project with no checkout can have no pull
            requests discovered for it, silently.
          */}
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void pick()}
              disabled={!isLive("chooseProjectDirectory")}
              aria-label={tx("Choose a working directory")}
              title={tx("Choose a folder")}
              class="shrink-0 cursor-pointer rounded-[9px] border border-primary/40 px-2 py-[7px] text-az-body transition-colors hover:border-primary hover:text-primary disabled:opacity-40"
            >
              <Icon name="folder-plus" class="text-[13px]" />
            </button>
            <input
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
          <Toggle
            aria-label={tx("Moderator for this session")}
            checked={props.project.moderatorEnabled}
            color="accent"
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

/** A project-local instruction, stored in KV and added to every turn. */
function ConciseResponseToggle(props: { projectId: string }): JSX.Element {
  const { actions, isLive } = useWorkspace();
  const [enabled, setEnabled] = createSignal(false);

  createEffect(() => {
    const id = props.projectId;
    void actions
      .getProjectConcise(id)
      .then(setEnabled)
      .catch((cause) => log.warn(`could not read concise responses: ${describeError(cause)}`));
  });

  const toggle = async (next: boolean): Promise<void> => {
    setEnabled(next);
    try {
      await actions.setProjectConcise(props.projectId, next);
    } catch (cause) {
      setEnabled(!next);
      log.error(`could not change concise responses: ${describeError(cause)}`);
    }
  };

  return (
    <div class="flex items-center gap-2.5">
      <Icon name="message-square-dashed" class="shrink-0 text-[14px] text-primary/75" />
      <span class="min-w-0 flex-1 text-[12px] text-az-body">
        {tx("Concise responses")}
        <span class="mt-px block text-[11px] text-az-muted">
          {tx("Lead with the answer and skip preambles for this project")}
        </span>
      </span>
      <Toggle
        aria-label={tx("Concise responses for this project")}
        checked={enabled()}
        color="accent"
        size="sm"
        disabled={!isLive("setProjectConcise")}
        onChange={(event) => void toggle(event.currentTarget.checked)}
      />
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
  const [level, setLevel] = createSignal("full");

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

  const agents = (): string[] =>
    Object.entries(props.project.sessions ?? {})
      .filter(([, id]) => Boolean(id))
      .map(([agent]) => agent);

  const reset = async (): Promise<void> => {
    setBusy(true);
    try {
      // Every agent that has a session on this project, so a project that ran
      // both providers is fully reset rather than half.
      await Promise.all(
        agents().map((agent) => actions.resetProjectSession(props.project.id, agent)),
      );
      setConfirming(false);
    } catch (cause) {
      log.error(`could not reset the session: ${describeError(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={agents().length > 0}>
      <div class="flex items-center gap-2.5">
        <Icon name="history" class="shrink-0 text-[14px] text-primary/75" />
        <span class="min-w-0 flex-1 text-[12px] text-az-body">
          {tx("Reset session")}
          <span class="mt-px block text-[11px] text-az-muted">
            {tx("Start the next message fresh — the recovery path for a wedged conversation")}
          </span>
        </span>
        <Show
          when={confirming()}
          fallback={
            <button
              type="button"
              class="btn btn-xs border-az-hairline bg-base-100 text-[11px]"
              disabled={props.running}
              title={props.running ? tx("Cancel the active run first") : undefined}
              onClick={() => setConfirming(true)}
            >
              {tx("Reset")}
            </button>
          }
        >
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              class="btn btn-xs btn-error text-[11px]"
              disabled={busy() || props.running}
              onClick={() => void reset()}
            >
              {tx("Confirm reset")}
            </button>
            <button
              type="button"
              class="btn btn-xs btn-ghost text-[11px]"
              disabled={busy()}
              onClick={() => setConfirming(false)}
            >
              {tx("Cancel")}
            </button>
          </div>
        </Show>
      </div>
    </Show>
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
        <button
          type="button"
          onClick={forget}
          class="shrink-0 rounded-md border border-primary/16 px-2 py-0.5 text-[11px] text-az-body transition-colors hover:border-error hover:text-error"
        >
          {tx("Forget all")}
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

  /*
   * The ladder lives in `lib/labels` now, because Home had its own and the
   * same click on the same row did different things on the two screens.
   *
   * Every stored state is in the cycle, including the two owner-only end
   * states. Agent directives cannot set those states, but this button belongs
   * to the owner and must be able to correct every row manually.
   */
  function advance(item: ProjectItem): void {
    void actions.setItemStatus(item.id, nextStatus(item.status));
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
    <div class="az-scroll flex min-h-0 flex-1 flex-col gap-0.5 px-2 pt-1.5 pb-2.5">
      <Show when={props.items.length > 3}>
        <div class="flex items-center gap-2 rounded-[9px] border border-az-hairline bg-az-inset px-2.5 py-1.5">
          <Icon name="search" class="shrink-0 text-[12px] text-primary/70" />
          <input
            type="text"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder={tx("Filter items…")}
            aria-label={tx("Filter items")}
            class="min-w-0 flex-1 bg-transparent text-[12px] text-az-body outline-none placeholder:text-az-faint"
          />
          <Show when={filtering()}>
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={tx("Clear the filter")}
              class="shrink-0 rounded-md p-0.5 text-az-faint transition-colors hover:text-az-body"
            >
              <Icon name="x" class="text-[11px]" />
            </button>
          </Show>
        </div>
      </Show>
      <Show when={filtering() && shown().length === 0}>
        <p class="px-2.5 py-3 text-[12px] text-az-muted">
          {tx("No item matches “{query}”", { query: query().trim() })}
        </p>
      </Show>
      <For each={shown()}>
        {(item, index) => (
          <Show
            when={editingId() !== item.id}
            fallback={
              <input
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
            <div
              /*
               * A column, not a row. The controls sat beside the title and
               * took a third of the width from it, so a title of any length
               * wrapped into a four-word column while the buttons kept their
               * space whether or not anyone was reaching for them.
               */
              class={`group flex flex-col rounded-[9px] transition-colors ${
                item.status === "active"
                  ? "bg-base-300 shadow-[inset_2px_0_0_var(--color-primary)]"
                  : // Zebra striping so a long list reads row by row; the hover
                    // still lifts on top of whichever stripe is underneath.
                    index() % 2 === 1
                    ? "bg-white/[0.02] hover:bg-white/5"
                    : "hover:bg-white/5"
              }`}
            >
              <div class="flex items-start gap-1">
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
                  aria-label={tx("Change the status of {name}", { name: item.title })}
                  title={`${statusSuffix(item.status)} — click for ${statusLabel(nextStatus(item.status))}`}
                  class="mt-0.5 ml-1.5 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-primary/12 focus-visible:bg-primary/12"
                >
                  <ItemMarker status={item.status} />
                </button>
                <div
                  data-selectable
                  class="flex min-w-0 flex-1 items-baseline gap-2.5 px-2.5 py-1 text-left"
                >
                  <span
                    class={`min-w-0 flex-1 text-[12.5px] ${
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
                    class={`shrink-0 text-[11px] ${
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
                    A shipped row shows its pull request instead of the word,
                    because the number is the thing you need to go and check.
                    Amber rather than green: shipped is a claim awaiting your
                    verdict, and colouring it as done is exactly the mistake
                    this state exists to prevent.
                  */}
                    <Show when={item.reference} fallback={statusSuffix(item.status)}>
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
                                <button
                                  type="button"
                                  onClick={() => void actions.openExternal(url())}
                                  title={tx("Open {url}", { url: url() })}
                                  class="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-primary"
                                >
                                  {tx("(PR #")}
                                  {reference()})
                                </button>
                              )}
                            </Show>
                          }
                        >
                          {(url) => (
                            <button
                              type="button"
                              onClick={() => void actions.openExternal(url())}
                              title={tx("Open {url}", { url: url() })}
                              class="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-primary"
                            >
                              {tx("(issue #")}
                              {issueNumber(url())})
                            </button>
                          )}
                        </Show>
                      )}
                    </Show>
                  </span>
                </div>
              </div>
              {/*
               * Bottom right, and only ink when the row is hovered or busy.
               * These act on the row; they are not part of reading it.
               */}
              <div class="flex items-center justify-end gap-1 px-2.5 pb-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <Show when={item.status !== "finished"}>
                  <button
                    type="button"
                    onClick={() => run(item)}
                    // Not gated on isLive: the mock serves sendMessage the same
                    // as the composer does, so the preview can exercise this.
                    disabled={isRunning()}
                    title={
                      isRunning()
                        ? tx("A run is already in flight on this project")
                        : tx("Send this item to the agent, on this project's session")
                    }
                    aria-label={tx("Run {name}", { name: item.title })}
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
                  class="shrink-0 rounded-md p-1 text-az-faint opacity-0 transition-[color,opacity] hover:text-primary group-hover:opacity-100"
                >
                  <Icon name="git-pull-request" class="text-[11px]" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditTitle(item.title);
                    setEditingId(item.id);
                  }}
                  aria-label={tx("Edit {name}", { name: item.title })}
                  title={tx("Edit this item")}
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
                  aria-label={tx("Delete {name}", { name: item.title })}
                  title={tx("Delete this item")}
                  class="shrink-0 rounded-md p-1 text-az-faint opacity-0 transition-[color,opacity] hover:text-error group-hover:opacity-100"
                >
                  <Icon name="x" class="text-[12px]" />
                </button>
                <div class="flex shrink-0 flex-col opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => move(index(), -1)}
                    disabled={filtering() || index() === 0}
                    aria-label={tx("Move {name} up", { name: item.title })}
                    class="rounded-sm px-0.5 text-az-faint transition-colors hover:text-az-body disabled:opacity-25"
                  >
                    <Icon name="chevron-up" class="text-[10px]" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index(), 1)}
                    disabled={filtering() || index() === props.items.length - 1}
                    aria-label={tx("Move {name} down", { name: item.title })}
                    class="rounded-sm px-0.5 text-az-faint transition-colors hover:text-az-body disabled:opacity-25"
                  >
                    <Icon name="chevron-down" class="text-[10px]" />
                  </button>
                </div>
              </div>
            </div>
          </Show>
        )}
      </For>

      <Show
        when={adding()}
        fallback={
          <button
            type="button"
            onClick={() => setAdding(true)}
            class="mt-1 flex items-center gap-2 rounded-[9px] border border-primary/16 border-dashed px-2.5 py-2 text-[12px] text-az-muted transition-colors hover:border-primary hover:text-primary"
          >
            <Icon name="plus" class="text-[13px]" />
            {tx("New item")}
          </button>
        }
      >
        <input
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
            {/*
             * Wrapped rather than truncated. This panel answers "what is it
             * doing right now", and a truncated command answers it for the
             * first forty characters. The task log below can be clicked open
             * because its rows are history; a running row is the present, so
             * it shows the whole thing.
             */}
            <div class="whitespace-pre-wrap break-words font-mono text-[12px] text-az-strong">
              {task.label}
            </div>
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
                {tx("Stop")}
              </button>
            </div>
          </div>
        )}
      </For>

      <Show when={tasks().length === 0}>
        <p class="rounded-[11px] border border-primary/12 border-dashed p-3 text-center text-[11.5px] text-az-muted">
          {tx("Nothing running")}
        </p>
      </Show>
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
              <button
                type="button"
                onClick={() => setExpanded(expanded() === entry.id ? null : entry.id)}
                aria-label={expanded() === entry.id ? tx("Collapse") : tx("Show the whole command")}
                class={`min-w-0 flex-1 cursor-pointer text-left text-az-body ${
                  expanded() === entry.id ? "whitespace-pre-wrap break-all" : "truncate"
                }`}
              >
                <span data-selectable>{entry.label}</span>
              </button>
              <span class={`shrink-0 ${entry.ok === false ? "text-error" : "text-az-muted"}`}>
                {taskMeta(entry)}
              </span>
              <button
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
              </button>
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
    <button
      type="button"
      onClick={() => void copy()}
      class="shrink-0 text-[11px] text-az-faint transition-colors hover:text-base-content"
    >
      {tx("Copy")}
    </button>
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
        <Toggle
          aria-label={tx("Knowledge checkpoints for this project")}
          checked={enabled()}
          color="accent"
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
      <textarea
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
          <button
            type="button"
            onClick={() => setDraft(saved())}
            class="shrink-0 text-[11px] text-az-faint transition-colors hover:text-base-content"
          >
            {tx("Revert")}
          </button>
        </Show>
        <button
          type="button"
          onClick={() => void save(draft())}
          disabled={!dirty() || status() === "saving" || !isLive("setProjectNotes")}
          class="shrink-0 rounded-lg border border-primary/18 px-2.5 py-[3px] text-[11.5px] text-az-body transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          {status() === "saving" ? tx("Saving…") : tx("Save")}
        </button>
        {/* Forgetting on purpose is a real thing to want: a project that
              changed direction is better off with nothing than with rules
              written for the work it used to be doing. */}
        <button
          type="button"
          onClick={() => void save("")}
          disabled={!saved().trim() || !isLive("setProjectNotes")}
          class="shrink-0 text-[11px] text-az-faint transition-colors hover:text-error disabled:cursor-not-allowed disabled:opacity-40"
        >
          {tx("Forget")}
        </button>
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
    <button
      type="button"
      onClick={() => void actions.clearTaskLog(props.projectId)}
      class="shrink-0 text-[11px] text-az-faint transition-colors hover:text-base-content"
    >
      {tx("Clear")}
    </button>
  );
}
