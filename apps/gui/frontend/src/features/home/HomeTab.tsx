import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { EditableTitle } from "~/components/EditableTitle";
import { Icon } from "~/components/Icon";
import { Panel, SectionPanel } from "~/components/Panel";
import { ItemMarker, StatusDot } from "~/components/StatusDot";
import { ApprovalCard } from "~/features/project/ApprovalCard";
import { AttachmentPills } from "~/features/project/Composer";
import { AgentIoList } from "~/features/project/ProjectPanel";
import { relativeTime } from "~/lib/format";
import { AGENT_LABELS, nextStatus, statusSuffix } from "~/lib/labels";
import { describeError, log } from "~/lib/log";
import { compileAdvancedPrompt } from "~/lib/promptEditor";
import { usageTotals } from "~/lib/stats";
import { tx } from "~/stores/i18n";
import { prefs, setPrefs, togglePanelSection } from "~/stores/prefs";
import { TASK_MANAGER_ID, useWorkspace } from "~/stores/workspace";
import type { Project, ProjectItem } from "~/types";

const STATUS_TONE: Record<ProjectItem["status"], string> = {
  active: "font-semibold text-primary",
  new: "text-az-muted",
  pending: "text-az-muted",
  planning: "text-info",
  // Amber and bold: this row is waiting on the person reading it.
  questions: "font-semibold text-warning",
  // Warning, not success: shipped means it is waiting on you to say whether it
  // worked, and reading it as done is the mistake the state exists to prevent.
  shipped: "font-semibold text-warning",
  finished: "text-success",
  canceled: "text-az-faint",
};

/**
 * Home: every project with its items, plus Pinned and Recent.
 *
 * Two layers, one status enum. Clicking a project group opens its tab — the
 * list is a way in, not a second workbench. One exception, by owner request:
 * item titles edit in place here, because Home is where the harvested lists
 * actually get read and corrected.
 */
export function HomeTab(): JSX.Element {
  const { state, actions, itemsFor, tabStatus } = useWorkspace();
  const [query, setQuery] = createSignal("");

  const ordered = createMemo(() => [...state.projects].sort((a, b) => a.order - b.order));

  /**
   * Search spans both layers: typing an item title surfaces the project that
   * holds it, with the group's other items still shown for context.
   */
  const matches = createMemo(() => {
    const needle = query().trim().toLowerCase();
    if (!needle) return ordered();
    return ordered().filter(
      (project) =>
        project.name.toLowerCase().includes(needle) ||
        itemsFor(project.id).some((item) => item.title.toLowerCase().includes(needle)),
    );
  });

  const pinned = createMemo(() => ordered().filter((project) => project.pinned));

  const recent = createMemo(() =>
    [...state.projects].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
  );

  return (
    <div class="flex min-w-0 flex-1 gap-3">
      <Panel class="flex min-w-0 flex-1 flex-col">
        <div class="flex flex-col gap-[11px] px-4 pt-4 pb-3">
          <div class="flex items-baseline gap-2.5 px-0.5">
            <span class="font-semibold text-[15px] text-base-content">{tx("Projects")}</span>
            <span class="text-[11.5px] text-az-faint">
              {tx("and their items · click a project to open its tab")}
            </span>
          </div>

          {/*
            Half the row each. Home is on its way to becoming a Task Manager
            project — the thing that keeps the project and task lists organised —
            so the left half is reserved for it now rather than leaving one
            oversized search box to be cut in two later.
          */}
          <div class="flex items-stretch gap-2.5">
            <TaskManagerComposer />

            <div class="flex min-w-0 flex-1 items-center gap-2.5 rounded-[11px] border border-primary/11 bg-az-inset px-3 py-2.5 focus-within:border-primary/40">
              <Icon name="search" class="shrink-0 text-[14px] text-primary/70" />
              <input
                type="search"
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
                placeholder={tx("Search projects and items…")}
                aria-label={tx("Search projects and items")}
                class="min-w-0 flex-1 bg-transparent text-[12.5px] text-base-content placeholder:text-az-muted focus:outline-none"
              />
              <kbd class="shrink-0 rounded-md border border-primary/25 bg-primary/8 px-[7px] py-0.5 font-mono text-[10.5px] text-primary/70">
                ⌘K
              </kbd>
            </div>
          </div>

          <TaskManagerStatus />
        </div>

        <div class="az-scroll flex min-h-0 flex-1 flex-col gap-2.5 px-3.5 pb-3.5">
          <For each={matches()}>{(project) => <ProjectGroup project={project} />}</For>
          <Show when={matches().length === 0}>
            <p class="px-2 py-6 text-center text-[12.5px] text-az-muted">
              {tx("Nothing matches “{query}”", { query: query() })}
            </p>
          </Show>
        </div>
      </Panel>

      <div class="flex w-[310px] flex-none flex-col gap-3">
        <button
          type="button"
          onClick={() => actions.openDraft()}
          class="flex items-center justify-center gap-2.5 rounded-panel bg-primary py-3.5 font-semibold text-[13.5px] text-primary-content shadow-[0_6px_20px_rgb(from_var(--color-primary)_r_g_b/.12)] transition-colors hover:bg-az-primary-hover"
        >
          <Icon name="plus" class="text-[17px]" />
          {tx("New Project")}
        </button>

        <Show when={pinned().length > 0}>
          <SectionPanel
            icon="pin"
            title={tx("Pinned")}
            count={pinned().length}
            isOpen={prefs.panelSections.pinned}
            onToggle={() => togglePanelSection("pinned")}
            class="flex-none"
          >
            <div class="flex flex-col gap-2 px-3 pt-3 pb-3">
              <For each={pinned()}>
                {(project) => (
                  <button
                    type="button"
                    onClick={() => actions.openProject(project.id)}
                    class="flex items-center gap-2.5 rounded-[11px] border border-primary/22 bg-base-300 px-3 py-2.5 text-left transition-colors hover:border-primary/50"
                  >
                    <StatusDot status={tabStatus(project.id)} />
                    <span class="min-w-0 flex-1 truncate font-semibold text-[12.5px] text-base-content">
                      {project.name}
                    </span>
                    <span class="shrink-0 text-[11px] text-az-muted">
                      {
                        itemsFor(project.id).filter(
                          (item) => item.status !== "finished" && item.status !== "canceled",
                        ).length
                      }{" "}
                      {tx("open")}
                    </span>
                  </button>
                )}
              </For>
            </div>
          </SectionPanel>
        </Show>

        <SectionPanel
          icon="history"
          title={tx("Recent")}
          count={recent().length}
          isOpen={prefs.panelSections.recent}
          onToggle={() => togglePanelSection("recent")}
          class={prefs.panelSections.recent ? "flex min-h-0 flex-1 flex-col" : "flex-none"}
        >
          <div class="az-scroll flex min-h-0 flex-1 flex-col gap-2 px-3 pt-3 pb-3">
            <For each={recent()}>
              {(project) => (
                <button
                  type="button"
                  onClick={() => actions.openProject(project.id)}
                  class="flex items-center gap-3 rounded-[11px] border border-az-hairline bg-base-300 px-3 py-2.5 text-left transition-colors hover:border-primary/40"
                >
                  <Icon name="folder-git-2" class="shrink-0 text-[15px] text-primary" />
                  <div class="flex min-w-0 flex-col gap-0.5">
                    <span class="truncate font-semibold text-[12.5px] text-base-content">
                      {project.name}
                    </span>
                    <span class="truncate font-mono text-[11px] text-az-muted">
                      {project.dirs[0] ?? tx("no working directory")}
                    </span>
                  </div>
                  <span class="ml-auto shrink-0 text-[11px] text-az-faint">
                    {state.running[project.id]?.length
                      ? tx("running now")
                      : relativeTime(project.lastActivityAt)}
                  </span>
                </button>
              )}
            </For>
          </div>
        </SectionPanel>

        {/*
          The task manager's raw exchange, beneath Recent per the plan: what
          went out with the output contract appended, and what came back
          before harvest() turned it into rows. Only once something has been
          sent — a diagnostic panel on a fresh install is noise.
        */}
        <Show when={(state.agentIo[TASK_MANAGER_ID] ?? []).length > 0}>
          <SectionPanel
            icon="terminal"
            title={tx("Task Manager I/O")}
            count={(state.agentIo[TASK_MANAGER_ID] ?? []).length}
            isOpen={prefs.panelSections.homeIo}
            onToggle={() => togglePanelSection("homeIo")}
            class={
              prefs.panelSections.homeIo ? "flex max-h-[300px] flex-none flex-col" : "flex-none"
            }
          >
            <AgentIoList projectId={TASK_MANAGER_ID} />
          </SectionPanel>
        </Show>
      </div>
    </div>
  );
}

/**
 * The Home task manager's prompt box — the left half of the header row.
 *
 * One line, because this is a list keeper, not a conversation you settle into:
 * "add X to project Y", "what's still open", paste a meeting's worth of notes.
 * The reply becomes item rows via `harvest()`; the raw exchange is in the
 * Agent I/O panel on the right.
 *
 * The draft is held until the send resolves, same as the project composer: a
 * backend failure must not swallow a prompt someone spent minutes writing.
 */
function TaskManagerComposer(): JSX.Element {
  const { state, actions, capabilitiesFor, isLive } = useWorkspace();
  const [draft, setDraft] = createSignal("");
  const [isSending, setIsSending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  /*
   * The one-liner is right for "add X to project Y"; a pasted meeting's worth
   * of notes needs to be read before it is sent. The toggle swaps the input
   * for a real textarea — same draft, same Enter-sends contract.
   */
  const [tall, setTall] = createSignal(false);

  /** Held as pills until send; the paths join the prompt body then. */
  const [attachments, setAttachments] = createSignal<string[]>([]);

  const attach = async (): Promise<void> => {
    try {
      const paths = await actions.chooseAttachments();
      if (paths.length === 0) return;
      setAttachments((current) => [...current, ...paths.filter((path) => !current.includes(path))]);
    } catch (cause) {
      log.warn(`could not attach: ${describeError(cause)}`);
    }
  };

  const isRunning = () =>
    TASK_MANAGER_ID in state.runStatus ||
    (state.running[TASK_MANAGER_ID] ?? []).length > 0 ||
    (state.streaming[TASK_MANAGER_ID] ?? "") !== "";
  const canFollowUp = () => {
    const selectedAgent = state.settings?.taskManager.agent ?? "claude";
    const runningAgent = state.runStatus[TASK_MANAGER_ID]?.agent;
    const agent = runningAgent ?? selectedAgent;
    return (
      (runningAgent === undefined || runningAgent === selectedAgent) &&
      (capabilitiesFor(agent)?.liveFollowUp ?? false)
    );
  };
  const waitsForRun = () => isRunning() && !canFollowUp();

  const submit = async (): Promise<void> => {
    const authored = draft();
    // The pills become prose on the way out; a file alone is a sendable
    // prompt ("eat this").
    const body = [authored.trim(), attachments().join("\n")]
      .filter((part) => part.length > 0)
      .join("\n\n");
    if (!body || isSending() || waitsForRun()) return;

    setError(null);
    setIsSending(true);
    try {
      const parsedAuthored = compileAdvancedPrompt(authored, []);
      await actions.sendTaskPrompt(body, {
        authoredCharacterCount: [...authored].length,
        authoredLineCount:
          authored.length === 0 ? 0 : authored.replaceAll("\r\n", "\n").split("\n").length,
        attachmentCount: attachments().length,
        userAuthoredPs: parsedAuthored.segments.some((segment) => segment.type === "directive"),
      });
      setDraft("");
      setAttachments([]);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setIsSending(false);
    }
  };

  const placeholder = () => {
    const label = AGENT_LABELS[state.settings?.taskManager.agent ?? "claude"];
    if (waitsForRun()) return `${label} task manager is finishing its current turn…`;
    return state.taskManagerSession
      ? tx("Tell {agent} task manager… · {session}", {
          agent: label,
          session: state.taskManagerSession,
        })
      : tx("Tell {agent} task manager…", { agent: label });
  };

  return (
    <div class="flex min-w-0 flex-1 flex-col">
      <div
        class={`flex min-w-0 flex-1 gap-2.5 rounded-[11px] border bg-az-inset px-3 py-2.5 focus-within:border-primary/40 ${
          tall() ? "items-start" : "items-center"
        } ${error() ? "border-error/40" : "border-primary/11"}`}
      >
        <Icon
          name="list-checks"
          class={`shrink-0 text-[14px] ${tall() ? "relative top-0.5" : ""} ${
            isRunning() ? "text-primary" : "text-az-muted"
          }`}
        />
        <Show
          when={tall()}
          fallback={
            <input
              value={draft()}
              onInput={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
              /*
               * The session id rides in the placeholder: same gray, gone the
               * moment you type, and it stops costing the line it used to sit on.
               */
              placeholder={placeholder()}
              aria-label={tx("Task manager prompt")}
              disabled={isSending() || waitsForRun()}
              class="min-w-0 flex-1 bg-transparent text-[12.5px] text-base-content placeholder:text-az-muted focus:outline-none disabled:opacity-60"
            />
          }
        >
          <textarea
            autofocus
            rows={6}
            value={draft()}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              // Same contract as the project composer: Enter sends,
              // Shift+Enter is a newline for the notes this mode exists for.
              if (event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              void submit();
            }}
            placeholder={placeholder()}
            aria-label={tx("Task manager prompt")}
            disabled={isSending() || waitsForRun()}
            class="az-scroll min-w-0 flex-1 resize-none bg-transparent text-[12.5px] text-base-content leading-[1.5] placeholder:text-az-muted focus:outline-none disabled:opacity-60"
          />
        </Show>
        <button
          type="button"
          onClick={() => void attach()}
          disabled={!isLive("chooseAttachments")}
          title={tx("Attach files — their paths go into the prompt for the task manager to read")}
          aria-label={tx("Attach files for the task manager")}
          class="shrink-0 text-az-faint transition-colors hover:text-az-body disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Icon name="plus" class="text-[14px]" />
        </button>
        <button
          type="button"
          onClick={() => setTall((open) => !open)}
          aria-pressed={tall()}
          title={tall() ? tx("Back to one line") : tx("Expand the prompt area")}
          aria-label={tall() ? tx("Shrink the prompt area") : tx("Expand the prompt area")}
          class="shrink-0 text-az-faint transition-colors hover:text-az-body"
        >
          <Icon name={tall() ? "chevron-up" : "chevron-down"} class="text-[14px]" />
        </button>
        <Show
          when={isRunning()}
          fallback={
            <kbd class="shrink-0 rounded-md border border-primary/25 bg-primary/8 px-[7px] py-0.5 font-mono text-[10.5px] text-primary/70">
              ↵
            </kbd>
          }
        >
          <span class="az-halo-primary size-2 shrink-0 rounded-full bg-primary" />
        </Show>
        {/*
          The debug reveal. The reply and collected list answer "what did the
          harvest actually do", which only matters when it did the wrong
          thing — so they hide behind this rather than costing space daily.
        */}
        <button
          type="button"
          onClick={() => togglePanelSection("tmDebug")}
          aria-pressed={prefs.panelSections.tmDebug}
          title={tx("Show the task manager's reply and collected list")}
          class={`shrink-0 transition-colors ${
            prefs.panelSections.tmDebug ? "text-primary" : "text-az-faint hover:text-az-body"
          }`}
        >
          <Icon name="terminal" class="text-[13px]" />
        </button>
      </div>
      <Show when={attachments().length > 0}>
        <div class="px-1 pt-1.5">
          <AttachmentPills
            paths={attachments()}
            onRemove={(path) =>
              setAttachments((current) => current.filter((existing) => existing !== path))
            }
          />
        </div>
      </Show>
      <Show when={error()}>
        {(message) => (
          <p role="alert" class="px-1 pt-1 text-[11px] text-error">
            {tx("Could not send — your prompt is still here.")} {message()}
          </p>
        )}
      </Show>
    </div>
  );
}

/**
 * What the task manager has said and collected: the session line and the
 * harvested tasks. Nothing renders until there is something to show, so a
 * fresh install's Home looks exactly as it did before the feature existed.
 */
function TaskManagerStatus(): JSX.Element {
  const { state, actions, itemsFor } = useWorkspace();
  const tasks = () => itemsFor(TASK_MANAGER_ID);

  /**
   * The latest reply, or the one being written right now.
   *
   * This has to be on screen: the agent's failure mode is to stop and ask —
   * "I can't read that, could you widen my permissions?" — and a question that
   * only exists in a diagnostic panel is a question nobody answers.
   */
  /**
   * The machine-readable block, hidden from the human. Harvest already turned
   * these lines into project items; re-reading them as prose is noise. Same
   * shape test as `harvest()`: a line that parses as JSON with a project and
   * an item.
   */
  const withoutTaskLines = (body: string): string =>
    body
      .split("\n")
      .filter((line) => {
        const bare = line.trim();
        if (!bare.startsWith("{")) return true;
        try {
          const parsed = JSON.parse(bare) as { project?: unknown; item?: unknown };
          return !(typeof parsed.project === "string" && typeof parsed.item === "string");
        } catch {
          return true;
        }
      })
      .join("\n")
      .trim();

  const reply = () => {
    const streaming = state.streaming[TASK_MANAGER_ID] ?? "";
    if (streaming) return { body: withoutTaskLines(streaming), isWriting: true };
    const list = state.messages[TASK_MANAGER_ID] ?? [];
    for (let at = list.length - 1; at >= 0; at--) {
      if (list[at].author === "agent" && list[at].body.trim()) {
        const body = withoutTaskLines(list[at].body);
        if (body) return { body, isWriting: false };
      }
    }
    return null;
  };

  return (
    <>
      {/* The task manager's run is blocked on this until you decide — it can
          never hide behind the debug toggle. */}
      <Show when={state.pendingApprovals[TASK_MANAGER_ID]}>
        {(approval) => <ApprovalCard projectId={TASK_MANAGER_ID} approval={approval()} />}
      </Show>

      <Show when={prefs.panelSections.tmDebug && reply()}>
        {(current) => (
          <div class="flex flex-col gap-1 rounded-[11px] border border-az-hairline-soft bg-az-inset px-3 py-2">
            <span class="text-[10.5px] text-az-faint">
              {current().isWriting ? tx("Task Manager · writing…") : tx("Task Manager")}
            </span>
            <p
              data-selectable
              class="az-scroll max-h-[120px] overflow-y-auto whitespace-pre-wrap text-[12px] text-az-body leading-[1.55]"
            >
              {current().body}
            </p>
          </div>
        )}
      </Show>

      <Show when={prefs.panelSections.tmDebug && tasks().length > 0}>
        {/*
          Leftovers only. Harvested tasks now land on real projects; anything
          still here was collected under the old flat scheme (or names the
          task manager's own housekeeping), so it earns a Clear.
        */}
        <div class="flex flex-col gap-0.5 rounded-[11px] border border-az-hairline-soft bg-az-inset px-2.5 py-2">
          <div class="flex items-center gap-2 px-1 pb-1">
            <span class="text-[10.5px] text-az-faint">
              {tx("collected ·")} {tasks().length}
            </span>
            <button
              type="button"
              onClick={() => {
                for (const task of tasks()) void actions.deleteItem(task.id);
              }}
              class="ml-auto rounded-md border border-az-hairline px-2 py-0.5 text-[10.5px] text-az-muted transition-colors hover:border-error hover:text-error"
            >
              {tx("Clear")}
            </button>
          </div>
          <div class="az-scroll flex max-h-[150px] flex-col gap-0.5 overflow-y-auto">
            <For each={tasks()}>
              {(task) => (
                <div class="flex items-baseline gap-2.5 px-1 py-1">
                  <ItemMarker status={task.status} />
                  <span class="min-w-0 flex-1 truncate text-[12px] text-az-body">{task.title}</span>
                  <span class={`shrink-0 text-[11px] ${STATUS_TONE[task.status]}`}>
                    {statusSuffix(task.status)}
                  </span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </>
  );
}

/**
 * One item row inside a Home project group.
 *
 * The row keeps the header's contract — single click folds, double click
 * opens the tab — and status still cannot be changed here. But the *title* is
 * editable in place, by owner request: the harvested lists are read and
 * corrected on Home, and "go open the project tab to fix a typo" was a rule
 * serving the doctrine rather than the person. The pencil reveals on hover
 * and is its own sibling control, so editing never triggers fold or open.
 */
function GroupItemRow(props: {
  item: ProjectItem;
  onFold: () => void;
  onOpen: () => void;
  /** Cycles through every owner-visible status, from the marker. */
  onAdvance: () => void;
}): JSX.Element {
  const { actions } = useWorkspace();
  const [editing, setEditing] = createSignal(false);
  const [title, setTitle] = createSignal("");

  const save = async (): Promise<void> => {
    const value = title().trim();
    setEditing(false);
    if (!value || value === props.item.title) return;
    try {
      await actions.updateItem(props.item.id, value);
    } catch (cause) {
      log.error(`could not rename the item: ${describeError(cause)}`);
    }
  };

  return (
    <Show
      when={!editing()}
      fallback={
        <input
          autofocus
          value={title()}
          aria-label={tx("Edit {name}", { name: props.item.title })}
          /*
           * Selecting text inside a field must not reach the row behind it.
           * Home's group header and item rows open a project on double click,
           * so double-clicking a word to select it — the ordinary way to fix a
           * typo — navigated away mid-edit and abandoned the change.
           */
          onClick={(event) => event.stopPropagation()}
          onDblClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onInput={(event) => setTitle(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
            if (event.key === "Escape") setEditing(false);
          }}
          onBlur={() => void save()}
          class="mx-2 my-1 rounded-[9px] border border-primary/40 bg-base-300 px-2.5 py-2 text-[12.5px] text-az-body focus:outline-none"
        />
      }
    >
      <div class="group flex items-baseline gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-white/4">
        {/*
         * The marker is the status control here too, matching the project
         * panel: a status change is deliberate, so it gets its own small
         * target rather than riding on a click meant to read the row.
         */}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            props.onAdvance();
          }}
          aria-label={tx("Change the status of {name}", { name: props.item.title })}
          title={tx("{status} — click to change", { status: statusSuffix(props.item.status) })}
          class="flex size-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-primary/12 focus-visible:bg-primary/12"
        >
          <ItemMarker status={props.item.status} />
        </button>
        <button
          type="button"
          onClick={props.onFold}
          onDblClick={props.onOpen}
          class="flex min-w-0 flex-1 items-baseline gap-2.5 text-left"
        >
          <span
            class={`min-w-0 flex-1 text-[12.5px] ${
              props.item.status === "active"
                ? "text-az-strong"
                : props.item.status === "finished"
                  ? "text-az-muted"
                  : "text-az-body"
            }`}
          >
            {props.item.title}
          </span>
        </button>
        <button
          type="button"
          onClick={() => {
            setTitle(props.item.title);
            setEditing(true);
          }}
          aria-label={tx("Edit {name}", { name: props.item.title })}
          title={tx("Edit this item")}
          class="shrink-0 rounded-md p-0.5 text-az-faint opacity-0 transition-[color,opacity] hover:text-az-body group-hover:opacity-100"
        >
          <Icon name="pencil" class="text-[11px]" />
        </button>
        <button
          type="button"
          onClick={() =>
            void actions
              .deleteItem(props.item.id)
              .catch((cause) => log.error(`could not delete the item: ${describeError(cause)}`))
          }
          aria-label={tx("Delete {name}", { name: props.item.title })}
          title={tx("Delete this item")}
          class="shrink-0 rounded-md p-0.5 text-az-faint opacity-0 transition-[color,opacity] hover:text-error group-hover:opacity-100"
        >
          <Icon name="x" class="text-[12px]" />
        </button>
        <span class={`shrink-0 text-[11.5px] ${STATUS_TONE[props.item.status]}`}>
          {statusSuffix(props.item.status)}
        </span>
      </div>
    </Show>
  );
}

function ProjectGroup(props: { project: Project }): JSX.Element {
  const { state, actions, itemsFor } = useWorkspace();

  const [confirming, setConfirming] = createSignal(false);
  const [isDeleting, setIsDeleting] = createSignal(false);

  /**
   * The row is removed by the `project:deleted` event, not here, so a delete the
   * backend refused leaves the project on screen rather than vanishing it
   * optimistically and lying about what is stored.
   */
  const remove = async (): Promise<void> => {
    setIsDeleting(true);
    try {
      await actions.deleteProject(props.project.id);
    } catch (cause) {
      log.error(`could not delete ${props.project.id}: ${describeError(cause)}`);
      setConfirming(false);
    } finally {
      setIsDeleting(false);
    }
  };

  const items = () => itemsFor(props.project.id);
  const openCount = () =>
    items().filter((item) => item.status !== "finished" && item.status !== "canceled").length;
  const activeCount = () => items().filter((item) => item.status === "active").length;
  const turnCount = () => usageTotals(state.messages[props.project.id] ?? []).turns;
  const summary = () =>
    activeCount()
      ? `${openCount()} open · ${turnCount()} turns · ${activeCount()} active`
      : `${openCount()} open · ${turnCount()} turns`;

  const collapsed = () => prefs.collapsedGroups.includes(props.project.id);

  /*
   * Single click folds, double click opens — distinguished by a short timer,
   * not by luck. Folding immediately on the first click would hide an item
   * row before the second click of a double could land on it, so the fold
   * waits long enough for a double-click to claim the gesture.
   */
  let clickTimer: number | undefined;
  const foldSoon = (): void => {
    window.clearTimeout(clickTimer);
    clickTimer = window.setTimeout(toggleCollapsed, 230);
  };
  const openNow = (): void => {
    window.clearTimeout(clickTimer);
    actions.openProject(props.project.id);
  };

  const toggleCollapsed = (): void => {
    setPrefs(
      "collapsedGroups",
      collapsed()
        ? prefs.collapsedGroups.filter((id) => id !== props.project.id)
        : [...prefs.collapsedGroups, props.project.id],
    );
  };

  return (
    /*
     * `flex-none` is load-bearing: this sits in a flex column, and
     * `overflow-hidden` sets the automatic minimum height to zero — so once
     * the column overflows, flexbox *compresses* the groups instead of
     * letting the column scroll. The projects with no items compressed to
     * 2px slivers, which read as four empty pills above the real groups.
     */
    <div class="flex-none overflow-hidden rounded-xl border border-az-hairline-soft bg-base-300">
      {/*
        Single click folds, double click opens the tab. The two coexist
        without timers: a double-click fires two clicks first, which toggle
        the fold there and back, and then the open lands. The row controls
        (pencil, pin, delete, chevron) stop propagation to stay themselves.
      */}
      {/* biome-ignore lint/a11y/useSemanticElements: the header carries its own buttons (pencil, pin, delete), and nesting those in a native button is invalid HTML — the same split SectionPanel makes. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed()}
        onClick={foldSoon}
        onDblClick={openNow}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleCollapsed();
          }
        }}
        class="flex cursor-pointer items-center gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-white/4"
      >
        {/*
          The name is its own control now, not part of the open-project button:
          a pencil nested inside a button would open the project on the way to
          editing it.
        */}
        <Icon name="folder-git-2" class="shrink-0 text-[15px] text-primary" />
        <EditableTitle
          value={props.project.name}
          onRename={(name) => actions.renameProject(props.project.id, name)}
          label={`Rename ${props.project.name}`}
          class="min-w-0 font-semibold text-[13px] text-base-content"
          inputClass="font-semibold text-[13px]"
        />
        {/*
          A plain stretch, deliberately. This used to be an "Open" button, and
          because it fills the header between name and pin, a single click
          almost anywhere on the row kept opening the project after the
          fold/double-click contract landed. The header owns the gesture now.
        */}
        <span class="flex min-w-0 flex-1 items-center gap-2.5">
          <span class={`shrink-0 text-[11.5px] ${STATUS_TONE[props.project.status]}`}>
            {statusSuffix(props.project.status)}
          </span>
          <span class="ml-auto shrink-0 text-[11.5px] text-az-muted">{summary()}</span>
        </span>

        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void actions.setProjectPinned(props.project.id, !props.project.pinned);
          }}
          aria-pressed={props.project.pinned}
          aria-label={props.project.pinned ? tx("Unpin project") : tx("Pin project")}
          class={`shrink-0 transition-colors ${props.project.pinned ? "text-primary" : "text-az-ghost hover:text-az-strong"}`}
        >
          <Icon name="pin" class="text-[14px]" />
        </button>

        {/*
          Two steps, in place, rather than a modal. Deleting a project takes its
          transcript and its task log with it and there is no undo, so a single
          click next to the pin toggle is too cheap — but a dialog for a row
          action is heavy, and the row is where the name is, which is the thing
          worth confirming.
        */}
        <Show
          when={confirming()}
          fallback={
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setConfirming(true);
              }}
              aria-label={tx("Delete {name}", { name: props.project.name })}
              class="shrink-0 text-az-ghost transition-colors hover:text-error"
            >
              <Icon name="x" class="text-[14px]" />
            </button>
          }
        >
          <div class="flex shrink-0 items-center gap-1.5">
            <span class="text-[11px] text-az-muted">{tx("Delete?")}</span>
            <button
              type="button"
              onClick={() => void remove()}
              disabled={isDeleting()}
              // Spells out that this cleans up rather than orphans: the backend
              // deletes the project's messages, items, PRs, agent I/O, message
              // overflow and session keys. Only the usage ledger is kept on
              // purpose (the money was spent whether or not the project stays).
              title={tx(
                "Removes this project and its transcript, items, pull requests and sessions from the store. Usage/cost history is kept.",
              )}
              class="rounded-md border border-error/40 bg-error/15 px-2 py-0.5 font-semibold text-[11px] text-error transition-colors hover:bg-error/25 disabled:opacity-50"
            >
              {isDeleting() ? tx("Deleting…") : tx("Delete")}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              class="rounded-md px-2 py-0.5 text-[11px] text-az-muted transition-colors hover:text-base-content"
            >
              {tx("Cancel")}
            </button>
          </div>
        </Show>

        <Icon
          name={collapsed() ? "chevron-right" : "chevron-down"}
          class="shrink-0 text-[14px] text-az-dim"
        />
      </div>

      {/*
        No inner cap and no inner scrollbar. The 220px window (and the
        "Show all" footer that lived, unreachably, inside its own scroll
        area) had a 23-item list scrolling in a porthole while the page
        below sat empty. The group grows to what it holds; the projects
        column is the one scroller, and folding the group is the tool for
        getting a long list out of the way.
      */}
      <Show when={!collapsed()}>
        <div class="flex flex-col border-az-hairline-soft border-t">
          <For each={items()}>
            {(item) => (
              <GroupItemRow
                item={item}
                onFold={foldSoon}
                onOpen={openNow}
                onAdvance={() => {
                  /*
                   * The same ladder the project panel walks. Home had its own,
                   * shorter one, so the same click on the same row meant two
                   * different things depending on which screen you were
                   * reading it from, and neither could reach `planning`,
                   * `shipped` or a row that needs an answer.
                   */
                  void actions
                    .setItemStatus(item.id, nextStatus(item.status))
                    .catch((cause) =>
                      log.error(`could not change the status: ${describeError(cause)}`),
                    );
                }}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
