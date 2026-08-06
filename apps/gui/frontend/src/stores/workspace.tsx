import {
  type Accessor,
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type ParentProps,
  useContext,
} from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import type { AgencyZeroApi, AppEvents, Unlisten } from "~/api";
import { selectApi } from "~/api";
import { PERMISSION_ORDER } from "~/lib/labels";
import { describeError, installGlobalErrorLogging, log } from "~/lib/log";
import { applyTheme } from "~/lib/theme";
import { prefs, setPrefs } from "~/stores/prefs";
import type {
  Agent,
  AgentIoEntry,
  AgentModels,
  AgentStatus,
  AvailableUpdate,
  ClaudeUsage,
  DataLocationView,
  GlobalSettings,
  Message,
  MessageReceipt,
  PendingApproval,
  Permission,
  PricingTable,
  Project,
  ProjectItem,
  ProjectStatus,
  PullRequest,
  Question,
  QuotaReport,
  RateLimit,
  RunningTask,
  StudyTurnMetadata,
  Tab,
  TabStatus,
  TaskLogEntry,
  WorkspaceRoot,
} from "~/types";

const TASK_LOG_PAGE = 40;

/** Matches `MAX_IO_ENTRIES` in `projects.rs`; see the `agent:io` handler. */
const AGENT_IO_LIMIT = 500;

const FALLBACK_EFFORT = "high";

/**
 * A compact model name for the composer pill.
 *
 * The catalogue name reads well in a menu ("Opus (1M context)") but is too long
 * beside a permission pill and a reasoning pill in XL font. Pull the window size
 * out of the parenthetical and append it bare — "Opus (1M context)" becomes
 * "Opus 1M" — and leave a name with no parenthetical untouched.
 */
export function shortModelName(name: string): string {
  const windowed = /^(.*?)\s*\(([\d.]+[mMkK])\b[^)]*\)\s*$/.exec(name);
  if (windowed) return `${windowed[1].trim()} ${windowed[2].toUpperCase()}`;
  // Any other parenthetical is a qualifier the pill does not need.
  return name.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

type WorkspaceState = {
  projects: Project[];
  items: Record<string, ProjectItem[]>;
  messages: Record<string, Message[]>;
  /** Live sent/read acknowledgements, keyed by project and message id. */
  messageReceipts: Record<string, Record<string, MessageReceipt>>;
  running: Record<string, RunningTask[]>;
  taskLog: Record<string, TaskLogEntry[]>;
  /** PRs cut during runs, per project, dismissed rows included. */
  pullRequests: Record<string, PullRequest[]>;
  /** Questions an agent raised, per project, answered ones included. */
  questions: Record<string, Question[]>;
  logTotals: Record<string, number>;
  /** The raw exchange with the agent, per project. Diagnostic, not persisted. */
  agentIo: Record<string, AgentIoEntry[]>;
  rateLimits: Record<string, Partial<Record<Agent, RateLimit>>>;
  /**
   * The approval question each project's run is blocked on, if any.
   *
   * One per project: the agent asks one question at a time, because it is
   * itself blocked until it hears back. Cleared by the answer or by the run
   * ending — a card for a run that already finished would collect a decision
   * nobody can deliver.
   */
  pendingApprovals: Record<string, PendingApproval>;
  settings: GlobalSettings | null;
  agents: AgentStatus[];
  /** Every agent's catalogue, for the Settings picker. Empty until boot ends. */
  models: AgentModels[];
  /** The per-token price table, for the composer's live cost estimate. Null until boot ends. */
  pricing: PricingTable | null;
  /** Where the tables were opened from. Null until boot ends. */
  dataLocation: DataLocationView | null;
  /** Where a new project runs. Null until boot ends. */
  workspaceRoot: WorkspaceRoot | null;
  /**
   * Where the account stands. Null until boot ends; a report with
   * `supported: false` is the honest answer, not a missing one.
   */
  quota: QuotaReport | null;
  /** Claude subscription usage, available only in the experimental profile. */
  claudeUsage: ClaudeUsage | null;
  /**
   * A newer published version, when the boot-time check found one. Null is
   * both "up to date" and "check failed" — the Settings row distinguishes,
   * the gear-dot nudge deliberately does not.
   */
  availableUpdate: AvailableUpdate | null;
  /**
   * The Home task manager's native session id, once a prompt has produced one.
   *
   * Not on a `Project`: the task manager is reserved under a fixed id with no
   * project row, so the session the ordinary path hangs off `ProjectDto` has
   * nowhere else to live.
   */
  taskManagerSession: string | null;
  /**
   * The reply currently being written, per project.
   *
   * Deliberately not a Message: it has no id, is never persisted, and is
   * replaced wholesale by the real row when the run finishes. Summing deltas is
   * for the eye only, and `Outcome::text` is what gets stored.
   */
  streaming: Record<string, string>;
  /**
   * The live run per project, from the moment a send is accepted until
   * `run:stopped`. The transcript's status line reads all three fields; the
   * key's mere presence is what "a run is in flight" means everywhere else.
   */
  runStatus: Record<string, RunStatus>;
  /**
   * Prompts written while a run was busy, oldest first. Sent automatically,
   * one per finished run — the backend's one-run-per-project rule holds; this
   * just stops the composer from bouncing the words back at the user.
   *
   * Each carries why it is waiting. "Queued" alone reads as the app having
   * quietly swallowed the message: the wait is only tolerable if you can see
   * what it is waiting *for*, and whether that is something you can end.
   */
  queued: Record<string, QueuedPrompt[]>;
  /**
   * Projects whose session is being rewritten by a `/compact` this window
   * asked for.
   *
   * Separate from `runStatus`, which a compaction also sets: this is the reason
   * *why* the project is busy, and it is what lets a send be queued under the
   * right label without reading it back out of an error string.
   */
  compacting: Record<string, boolean>;
  /**
   * What each project's agent reported it can do, from its own catalogue.
   *
   * Per project because the agent, its plugins and its skills can differ per
   * conversation. Empty until a run reports one, which is why the composer's
   * parser treats an absent catalogue as "do not second-guess me" rather than
   * as "nothing exists".
   */
  commands: Record<string, Partial<Record<Agent, { all: string[]; skills: string[] }>>>;
  tabs: Tab[];
  activeKey: string;
  backend: "tauri" | "mock" | "hybrid" | "loading";
  /** Which API methods reach Rust. Empty on the mock; see `isLive`. */
  live: (keyof AgencyZeroApi)[];
  /**
   * "not finished" and "failed" are different things, and a single boolean
   * cannot tell them apart — a failure halfway through hydration would leave
   * the window on a loading screen forever with nothing to explain it.
   */
  boot: BootState;
};

export type BootState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string };

/** What the transcript's status line knows about a run in flight. */
export type RunStatus = {
  /** The provider and posture of this run, independent of the tab's next turn. */
  agent: Agent;
  model: string;
  permission: Permission;
  /** Wall-clock ms when the send was accepted; the elapsed timer's zero. */
  startedAt: number;
  /** What the agent is doing right now, in a couple of words. */
  activity: string;
  /**
   * How many streamed characters are checkpointed in the store — what the
   * saved/unsaved dot compares against `streaming.length`.
   */
  persistedChars: number;
  /**
   * The turn's tokens so far, from `run:usage`, on the same definition the
   * header totals use. Null until the first API request completes, and for
   * agents that report no mid-turn usage; the character estimate covers that
   * gap.
   */
  liveTokens: number | null;
  /**
   * The conversation's size and the window it sits in, as of the last report.
   *
   * Kept here rather than read back out of the stored rows because a row is
   * only written when a turn lands: the composer's context readout froze for
   * the whole of a run and then jumped. Null until the agent reports one, and
   * for agents that never do — the readout falls back to the stored totals.
   */
  contextTokens: number | null;
  contextWindow: number | null;
};

/**
 * Why a prompt is waiting instead of being sent.
 *
 * Only what the window can actually tell apart. `busy` is the settle-race and
 * the mock's refusal — the slot is taken and frees itself. `compacting` is the
 * session being rewritten, which is the one the user has to be told about,
 * because a compaction takes long enough that silence reads as a lost message.
 *
 * Deliberately short of the full list: telling a backend that is down from a
 * model that refused needs the crate's own error classification carried across
 * the IPC boundary, which is its own piece of work.
 */
export type QueueReason = "busy" | "compacting";

/** A prompt held back, and what it is held back for. */
export type QueuedPrompt = {
  body: string;
  reason: QueueReason;
  /** Reuse this visible transcript row instead of appending the words twice. */
  messageId?: string;
  study?: StudyTurnMetadata;
};

/** What the chip above the composer says while a prompt waits. */
export const QUEUE_REASONS: Record<QueueReason, string> = {
  busy: "queued · session busy",
  compacting: "queued · waiting for the compaction",
};

/**
 * Whether a refused send is worth holding on to, and under what label.
 *
 * Matched on the message text, which is the honest description of what this
 * does rather than a defence of it: the backend's refusals cross the IPC
 * boundary as plain strings, so there is nothing else to match on. Kept in one
 * place so replacing it — by carrying the crate's own error classification
 * across that boundary — is one edit rather than a hunt.
 *
 * Anything unrecognised is *not* queued. A prompt held for a reason the window
 * cannot name would wait for a slot that may never free, so it goes back to the
 * composer as an error instead.
 */
export function queueReason(cause: unknown): QueueReason | null {
  const text = describeError(cause);
  if (text.includes("a command is running")) return "compacting";
  if (text.includes("already active")) return "busy";
  return null;
}

/**
 * A limit is only in force until its reset time; after that it is history.
 *
 * A missing or unparseable `resetsAt` counts as live: the provider did not say
 * when it lifts, and guessing "already over" would clear a real limit.
 */
export function isLimitLive(limit: RateLimit, now = Date.now()): boolean {
  if (!limit.resetsAt) return true;
  const resets = Date.parse(limit.resetsAt);
  return Number.isNaN(resets) || resets > now;
}

/**
 * The Home task manager's reserved project id. A constant so it survives a
 * restart without a lookup, prefixed differently from `proj-` so it can never
 * collide with a real project. Mirrors `tasks::TASK_MANAGER_ID` in Rust.
 */
export const TASK_MANAGER_ID = "home-task-manager";

const HOME_TAB: Tab = {
  key: "home",
  kind: "home",
  projectId: null,
  label: "Home",
  agent: "claude",
  model: "sonnet",
  effort: FALLBACK_EFFORT,
  extraThinking: true,
  permission: "read_only",
  status: "quiet",
};

/** Project runs support these two providers; Copilot remains Settings-only. */
function isProjectAgent(agent: Agent): agent is "claude" | "codex" {
  return agent === "claude" || agent === "codex";
}

function compatiblePermission(
  statuses: readonly AgentStatus[],
  agent: Agent,
  permission: Permission,
): Permission {
  const canAsk = statuses.find((status) => status.agent === agent)?.capabilities.approvals ?? false;
  return !canAsk && permission === "ask" ? "read_only" : permission;
}

function createWorkspace() {
  const [state, setState] = createStore<WorkspaceState>({
    projects: [],
    items: {},
    messages: {},
    messageReceipts: {},
    running: {},
    taskLog: {},
    pullRequests: {},
    questions: {},
    logTotals: {},
    agentIo: {},
    rateLimits: {},
    pendingApprovals: {},
    taskManagerSession: null,
    settings: null,
    agents: [],
    models: [],
    pricing: null,
    dataLocation: null,
    workspaceRoot: null,
    quota: null,
    claudeUsage: null,
    availableUpdate: null,
    streaming: {},
    runStatus: {},
    compacting: {},
    queued: {},
    commands: {},
    tabs: [HOME_TAB],
    activeKey: "home",
    backend: "loading",
    live: [],
    boot: { status: "loading" },
  });

  const [api, setApi] = createSignal<AgencyZeroApi | null>(null);
  const unlisteners: Unlisten[] = [];

  /** Monotonic ticket for settings writes; see `saveSettings`. */
  let settingsWrite = 0;

  /** Events that arrived while snapshots were still loading — see `init`. */
  let buffered: (() => void)[] = [];
  let isHydrating = true;

  function drainEventBuffer(): void {
    isHydrating = false;
    const queued = buffered;
    buffered = [];
    batch(() => {
      for (const apply of queued) apply();
    });
  }

  /**
   * A coarse reactive clock, so time-dependent state re-evaluates without a
   * timer per rate limit. 30s is far below the resolution anyone reads off a
   * status dot, and it is a display aid — expiry is also checked on hydration
   * and answered by `run:rate_limit_cleared`, because a suspended app misses
   * timers entirely.
   */
  const [clock, setClock] = createSignal(Date.now());
  const clockTimer = setInterval(() => setClock(Date.now()), 30_000);
  onCleanup(() => clearInterval(clockTimer));

  /*
   * Pull requests are asked about again on a timer.
   *
   * Nothing did. A row was written when the agent mentioned the URL and then
   * never changed unless someone clicked the CI badge, so a pull request that
   * had merged an hour ago still read as open, and the panel that exists to
   * tell you where your work stands was the least current thing on screen.
   *
   * Only rows that can still change: `MERGED` and `CLOSED` are endings, and
   * a dismissed row is not on screen to be wrong. Ninety seconds because each
   * one is a `gh` subprocess, and this is a state that changes on human
   * timescales.
   */
  /*
   * Short, because the query is now one process per repository rather than
   * one per pull request, and gated on focus, because most of the old cost
   * was asking on behalf of a window nobody was looking at.
   */
  const PR_REFRESH_MS = 20_000;
  const refreshOpenPullRequests = (projectId?: string): void => {
    if (!isLive("refreshPullRequest")) return;
    // A hidden window is not being read, so it is not worth asking for.
    if (typeof document !== "undefined" && document.hidden && !projectId) return;
    const lists = projectId ? [state.pullRequests[projectId]] : Object.values(state.pullRequests);
    for (const list of lists) {
      for (const pr of list ?? []) {
        if (pr.dismissed || pr.state === "MERGED" || pr.state === "CLOSED") continue;
        void Promise.resolve(client().refreshPullRequest(pr.id)).catch((cause) =>
          log.warn(`could not refresh ${pr.repo}#${pr.number}: ${describeError(cause)}`),
        );
      }
    }
  };
  const prTimer = setInterval(refreshOpenPullRequests, PR_REFRESH_MS);
  onCleanup(() => clearInterval(prTimer));

  const client = (): AgencyZeroApi => {
    const current = api();
    if (!current) throw new Error("workspace used before the backend was selected");
    return current;
  };

  /*
   * The strip persists itself: whichever project tabs are open is written
   * through to prefs, so the next launch restores the arrangement. Guarded on
   * boot being ready — before hydration the strip is just Home, and writing
   * that through would erase the very list boot is about to restore.
   */
  createEffect(() => {
    if (state.boot.status !== "ready") return;
    setPrefs(
      "openTabKeys",
      state.tabs.filter((tab) => tab.kind === "project").map((tab) => tab.key),
    );
  });

  // — derived ————————————————————————————————————————————————————

  const activeTab = createMemo(
    () => state.tabs.find((tab) => tab.key === state.activeKey) ?? HOME_TAB,
  );

  const activeProject = createMemo(() => {
    const projectId = activeTab().projectId;
    return projectId ? (state.projects.find((project) => project.id === projectId) ?? null) : null;
  });

  /**
   * The dot on a tab, derived rather than stored: an unresolved moderator hold
   * outranks a live tool call, which outranks quiet. Storing it would mean
   * four call sites remembering to keep it in step.
   */
  function tabStatus(projectId: string): TabStatus {
    // A tool approval is a live question only the owner can answer. It must
    // outrank "running" so a background tab calls for attention in red while
    // the agent is blocked mid-turn.
    if (state.pendingApprovals[projectId]) return "blocked";

    const held = (state.messages[projectId] ?? []).some(
      (message) => message.moderation?.needsApproval === true,
    );
    if (held) {
      return state.messages[projectId]?.some(
        (message) =>
          message.moderation?.needsApproval && message.moderation.severity === "critical",
      )
        ? "error"
        : "blocked";
    }

    /*
     * An `@agency:ask` the owner has not answered. `critical` is the run
     * shouting for help now and reads as an error; `blocking` is the run
     * stopped until answered and reads as blocked. Both outrank a live tool
     * call — a question waiting is more urgent than work in flight — but not a
     * moderation hold above, which has already stopped the run for safety.
     * `passive` is "answer when free, I keep working", so it does not gate the
     * dot and falls through to the running/ready state below.
     */
    const open = (state.questions[projectId] ?? []).filter((question) => !question.answered);
    if (open.some((question) => question.urgency === "critical")) return "error";
    if (open.some((question) => question.urgency === "blocking")) return "blocked";

    /*
     * An item left on `questions` is the older way to say "stopped, owner
     * needed" — `items.state(id, status: "questions")`, distinct from an
     * `@agency:ask` row. The principle is one: any tab that needs a human turns
     * red. So this gates the dot too, not just the question entity, and a
     * project an agent parked on a question does not read as quiet.
     */
    if ((state.items[projectId] ?? []).some((item) => item.status === "questions")) {
      return "blocked";
    }
    /*
     * Only a limit that actually refused something counts as blocked. The
     * provider also emits an "allowed" heartbeat mid-run, and treating that as a
     * limit turned the dot amber on a run that was never restricted.
     *
     * Liveness is checked rather than trusted: a suspended app misses timers, so
     * an entry can outlive its reset time without anything having cleared it.
     */
    const selectedAgent =
      state.runStatus[projectId]?.agent ??
      state.tabs.find((tab) => tab.projectId === projectId)?.agent ??
      [...(state.messages[projectId] ?? [])].reverse().find((message) => message.author === "agent")
        ?.agent ??
      "claude";
    const limit = state.rateLimits[projectId]?.[selectedAgent];
    if (limit?.isBlocking && isLimitLive(limit, clock())) return "blocked";
    if ((state.running[projectId] ?? []).length > 0) return "running";

    /*
     * Idle, so the question is whether this project is still live work.
     *
     * `quiet` used to cover both, which meant a project sitting there waiting
     * for you rendered exactly like one you had finished with. The project's own
     * status is what tells them apart: `active` is waiting on you, anything else
     * is done or not started.
     */
    const project = state.projects.find((candidate) => candidate.id === projectId);
    return project?.status === "active" ? "ready" : "quiet";
  }

  /** Models enabled in Settings for the two project-capable agents. */
  const promptModels = createMemo(() => {
    return (["claude", "codex"] as const).flatMap((agent) => {
      const catalogue = state.models.find((entry) => entry.agent === agent);
      const enabled = state.settings?.models[agent].enabled ?? [];
      const provider = agent === "claude" ? "Claude" : "OpenAI";
      return (catalogue?.models ?? [])
        .filter((model) => enabled.includes(model.id))
        .map((model) => ({
          value: `${agent}:${model.id}`,
          label: `${provider} · ${model.name}`,
          // A compact name for the composer pill, where the full
          // "Claude · Opus (1M context)" crowds the XL-font control row: drop
          // the provider and squeeze "(1M context)" to "1M".
          triggerLabel: shortModelName(model.name),
          agent,
          model: model.id,
        }));
    });
  });

  /**
   * Whether a command is backed by Rust rather than by fixtures.
   *
   * Used to grey out controls whose backend does not exist yet, so wiring
   * progress is visible in the UI instead of tracked in a document that goes
   * stale.
   *
   * Outside Tauri this always answers true. There is no Rust process to be
   * backed by, and greying out the entire Settings screen would defeat the
   * design-review pass the mock exists for. The footer already says the whole
   * window is running on fixtures, which is the honest signal in that mode.
   */
  function isLive(method: keyof AgencyZeroApi): boolean {
    if (state.backend === "mock") return true;
    return state.live.includes(method);
  }

  /**
   * The reasoning ladder a model accepts.
   *
   * From the catalogue, which is the only place a model fact lives. Empty means
   * the crate establishes no ladder for that model, and the composer hides the
   * control rather than guessing at one.
   */
  function effortsFor(agent: Agent, modelId: string): string[] {
    const catalogue = state.models.find((entry) => entry.agent === agent);
    return catalogue?.models.find((model) => model.id === modelId)?.efforts ?? [];
  }

  function capabilitiesFor(agent: Agent) {
    return state.agents.find((status) => status.agent === agent)?.capabilities;
  }

  function permissionsFor(agent: Agent): Permission[] {
    return capabilitiesFor(agent)?.approvals
      ? [...PERMISSION_ORDER]
      : PERMISSION_ORDER.filter((permission) => permission !== "ask");
  }

  function itemsFor(projectId: string): ProjectItem[] {
    // Sorted here, not trusted from the array: a reorder arrives as
    // `item:updated` events that change `order` in place, and the array's
    // insertion order never moves.
    return [...(state.items[projectId] ?? [])].sort((a, b) => a.order - b.order);
  }

  /** The Items badge counts what is left to do, so finished items drop out. */
  function openItemCount(projectId: string): number {
    return itemsFor(projectId).filter((item) => item.status !== "finished").length;
  }

  // — loading ————————————————————————————————————————————————————

  async function loadProject(projectId: string): Promise<void> {
    const backend = client();
    const [items, messages, running, log, io, prs, questions] = await Promise.all([
      backend.listItems(projectId),
      backend.listMessages(projectId),
      backend.listRunningTasks(projectId),
      backend.listTaskLog(projectId, TASK_LOG_PAGE),
      backend.listAgentIo(projectId),
      backend.listPullRequests(projectId),
      backend.listQuestions(projectId),
    ]);
    const project = state.projects.find((candidate) => candidate.id === projectId);
    const hydratedTab = project ? projectTab(project, messages) : null;
    batch(() => {
      setState("items", projectId, reconcile(items));
      setState("messages", projectId, reconcile(messages));
      setState("running", projectId, reconcile(running));
      setState("taskLog", projectId, reconcile(log.entries));
      setState("logTotals", projectId, log.total);
      setState("agentIo", projectId, reconcile(io));
      setState("pullRequests", projectId, reconcile(prs));
      setState("questions", projectId, reconcile(questions));
      if (hydratedTab) {
        const tabIndex = state.tabs.findIndex((tab) => tab.key === projectId);
        if (tabIndex >= 0) {
          setState("tabs", tabIndex, {
            agent: hydratedTab.agent,
            model: hydratedTab.model,
            permission: hydratedTab.permission,
          });
        }
      }
    });
    /*
     * Ask about this project's open pull requests now rather than at the next
     * tick. Opening a tab is exactly when the rows are read, and a stored row
     * is only as current as the last time anyone asked.
     *
     * `refreshOpenPullRequests` only re-asks about rows that already exist, so a
     * project opened with none discovered nothing and a freshly-pushed PR showed
     * up only after an authored `pr.link`. `discoverPullRequests` asks by
     * project — the backend reads its git remotes and inserts any open PR it
     * finds — so a chip appears because the PR exists, not because its URL was
     * pasted.
     */
    if (isLive("discoverPullRequests")) void client().discoverPullRequests(projectId);
    refreshOpenPullRequests(projectId);
  }

  /**
   * Boot, in an order that cannot drop an event.
   *
   * Subscribing after hydration leaves a window — one round trip per project —
   * in which a tool could start, a moderator could block, or a run could stop,
   * and the window would never hear about it. Since events are treated as
   * authoritative, a miss is permanent.
   *
   * So: subscribe first, buffer everything that arrives, hydrate, then replay
   * the buffer over the snapshot. Handlers are idempotent — they upsert by id
   * rather than append blindly — so replaying an event the snapshot already
   * contains is a no-op rather than a duplicate.
   */
  async function init(): Promise<void> {
    // Each step is announced before it is awaited, so a boot that never
    // finishes says which step it stopped on. Without this the window shows
    // "Loading workspace…" forever and the log is silent, which is the state
    // this app shipped in once already.
    installGlobalErrorLogging();
    log.info("boot: selecting a backend");
    try {
      const { api: backend, backend: kind, live } = await selectApi();
      log.info(`boot: backend=${kind}, ${live.size} live commands`);
      setApi(() => backend);
      batch(() => {
        setState("backend", kind);
        setState("live", [...live]);
      });

      log.info("boot: subscribing to events");
      await subscribe(backend);

      log.info("boot: hydrating");
      const [projects, settings, agents, models, pricing, dataLocation, workspaceRoot, rateLimits] =
        await Promise.all([
          backend.listProjects(),
          backend.getSettings(),
          backend.listAgentStatus(false),
          // Compiled catalogues only. Discovery spawns a CLI per agent, which is
          // too slow to sit in front of the first paint; Settings can ask for it.
          backend.listModels(false),
          backend.pricingTable(),
          backend.getDataLocation(),
          backend.getWorkspaceRoot(),
          backend.listRateLimits(),
        ]);

      // Before the first paint of anything themed: the stylesheet's defaults are
      // the designed palette, so a saved theme arriving late would show as a
      // flash of the old colours on every launch.
      applyTheme(settings.theme);

      batch(() => {
        setState("projects", reconcile(projects));
        setState("settings", settings);
        setState("agents", reconcile(agents));
        setState("models", reconcile(models));
        setState("pricing", pricing);
        setState("dataLocation", dataLocation);
        setState("workspaceRoot", workspaceRoot);
        setState(
          "rateLimits",
          // A limit whose reset time has already passed is history, not state.
          rateLimits.filter(isLimitLive).reduce<WorkspaceState["rateLimits"]>((indexed, limit) => {
            const projectLimits = indexed[limit.projectId] ?? {};
            projectLimits[limit.agent] = limit;
            indexed[limit.projectId] = projectLimits;
            return indexed;
          }, {}),
        );
        /*
         * Only the tabs that were open when the app last ran. Boot used to
         * open a tab per project, which meant a restart quietly un-did every
         * close; the strip is the user's arrangement, and it should survive
         * the process. Everything else is one click away on Home.
         */
        const remembered = new Set(prefs.openTabKeys);
        setState("tabs", [
          HOME_TAB,
          ...projects
            .filter((project) => remembered.has(project.id))
            .map((project) => projectTab(project)),
        ]);
        const restored = state.tabs.some((tab) => tab.key === prefs.lastTabKey);
        setState("activeKey", restored ? prefs.lastTabKey : "home");
      });

      log.info(`boot: loading ${projects.length} project(s)`);
      await Promise.all([
        ...projects.map((project) => loadProject(project.id)),
        /*
         * The task manager rides along: it has no project row, so it is not
         * in `projects`, but its transcript, harvested items and I/O live
         * under its fixed id like anyone else's.
         */
        loadProject(TASK_MANAGER_ID),
        client()
          .getTaskManager()
          .then((tm) => setState("taskManagerSession", tm.sessionId)),
      ]);

      drainEventBuffer();
      setState("boot", { status: "ready" });
      log.info("boot: ready");

      // After ready, not during: an update nobody has asked to install must
      // never delay first paint, and a failed check is a log line, not a
      // boot error.
      void checkForUpdate().catch((cause) =>
        log.warn(`update check failed: ${describeError(cause)}`),
      );
    } catch (cause) {
      // A half-loaded workspace is not something to render as if it were whole.
      log.error(`boot failed: ${describeError(cause)}`);
      setState("boot", {
        status: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  /**
   * Ask where the account stands.
   *
   * Deliberately **not** part of boot: `account_usage` spawns `codex
   * app-server` and waits on three round trips, which put a second onto every
   * launch for a figure nobody needs before the window paints. The usage strip
   * asks for it once the workspace is ready, and again each minute.
   *
   * A failure leaves the last answer in place rather than blanking the readout:
   * a stale figure beats no figure, and `checkedAt` says how stale.
   */
  /**
   * Ask whether a newer version is published, and remember the answer.
   *
   * Returns what it found so Settings' explicit Check button can also say
   * "you are up to date" — which the passive boot check never claims, since
   * its failure and a current install look identical in state.
   */
  async function checkForUpdate(): Promise<AvailableUpdate | null> {
    const found = await client().checkForUpdate();
    setState("availableUpdate", found);
    if (found) log.info(`update available: ${found.version}`);
    return found;
  }

  async function refreshQuota(): Promise<void> {
    try {
      setState("quota", await client().listQuota());
    } catch (cause) {
      log.warn(`could not refresh the quota: ${describeError(cause)}`);
    }
  }

  async function refreshClaudeUsage(): Promise<void> {
    try {
      setState("claudeUsage", await client().claudeUsage());
    } catch (cause) {
      log.warn(`could not refresh Claude usage: ${describeError(cause)}`);
      throw cause;
    }
  }

  /** Boot again from scratch, for the retry button on the error screen. */
  async function retryInit(): Promise<void> {
    for (const unlisten of unlisteners.splice(0)) unlisten();
    buffered = [];
    isHydrating = true;
    setState("boot", { status: "loading" });
    await init();
  }

  /**
   * What a new tab starts on: the default project-capable agent and model.
   *
   * Read from settings rather than from `prefs.lastModel`, which used to seed
   * this and silently won. Two places claiming to own "the default model" meant
   * picking Opus in Settings and still getting Sonnet in the next tab, because
   * the pref remembered the last model *used* and shadowed the configured one.
   * Settings owns it; the pref is gone.
   */
  function defaultEffort(): string {
    return state.settings?.defaultEffort ?? FALLBACK_EFFORT;
  }

  function defaultAgent(): "claude" | "codex" {
    return state.settings?.defaultAgent === "codex" ? "codex" : "claude";
  }

  function defaultModel(): string {
    const settings = state.settings;
    if (!settings) return "";
    return settings.models[defaultAgent()]?.default ?? "";
  }

  /**
   * Restore the provider that most recently owned this conversation.
   *
   * Messages are authoritative because they preserve ordering. The session map
   * is only the pre-hydration fallback, and only when exactly one provider has
   * a session; two session ids cannot say which one ran last.
   */
  function projectSelection(project: Project, transcript: readonly Message[]) {
    const last = [...transcript]
      .reverse()
      .find(
        (message) =>
          (message.author === "user" || message.author === "agent") &&
          isProjectAgent(message.agent),
      );
    const lastAgent = last && isProjectAgent(last.agent) ? last.agent : null;
    const hasClaude = Boolean(project.sessions.claude ?? project.sessionId);
    const hasCodex = Boolean(project.sessions.codex);
    const agent = lastAgent
      ? lastAgent
      : hasClaude !== hasCodex
        ? hasCodex
          ? "codex"
          : "claude"
        : defaultAgent();
    const selection = state.settings?.models[agent];
    const model =
      last?.model && selection?.enabled.includes(last.model)
        ? last.model
        : (selection?.default ?? "");
    const permission = compatiblePermission(
      state.agents,
      agent,
      last?.permission ?? state.settings?.defaultPermission ?? "read_only",
    );
    return { agent, model, permission };
  }

  function projectTab(project: Project, transcript = state.messages[project.id] ?? []): Tab {
    const selection = projectSelection(project, transcript);
    return {
      key: project.id,
      kind: "project",
      projectId: project.id,
      label: project.name,
      agent: selection.agent,
      model: selection.model,
      effort: defaultEffort(),
      extraThinking: prefs.lastExtraThinking,
      permission: selection.permission,
      status: "quiet",
    };
  }

  // — events ——————————————————————————————————————————————————————
  //
  // The agent runs the same mutations the user does, so the window is only
  // correct if it treats these as the source of truth rather than trusting its
  // own optimistic writes.

  async function subscribe(backend: AgencyZeroApi): Promise<void> {
    /**
     * While hydrating, an event is queued instead of applied — the snapshot
     * that lands next would overwrite it. Queued events are replayed after.
     */
    const bind = async <E extends keyof AppEvents>(
      event: E,
      handler: (payload: AppEvents[E]) => void,
    ) => {
      unlisteners.push(
        await backend.on(event, (payload) => {
          if (isHydrating) buffered.push(() => handler(payload));
          else handler(payload);
        }),
      );
    };

    // No tab is opened here. The agent creates projects too, and a new tab
    // appearing in the strip mid-sentence would be the agent taking the window
    // from you. It lands in Home; opening it is a click.
    await bind("project:created", (project) => {
      upsertProject(project);
      void loadProject(project.id);
    });

    await bind("project:updated", upsertProject);

    await bind("project:deleted", ({ id }) => purgeProject(id));

    await bind("item:created", (item) => {
      setState("items", item.projectId, (list = []) => [...list, item]);
    });

    await bind("item:updated", (item) => {
      setState("items", item.projectId, (list = []) =>
        list.map((existing) => (existing.id === item.id ? item : existing)),
      );
    });

    await bind("item:deleted", ({ id, projectId }) => {
      setState("items", projectId, (list = []) => list.filter((item) => item.id !== id));
    });

    await bind("pr:updated", (pr) => {
      setState("pullRequests", pr.projectId, (list = []) => {
        const index = list.findIndex((existing) => existing.id === pr.id);
        if (index < 0) return [...list, pr];
        const next = [...list];
        next[index] = pr;
        return next;
      });
    });

    await bind("question:updated", (question) => {
      setState("questions", question.projectId, (list = []) => {
        const index = list.findIndex((existing) => existing.id === question.id);
        if (index < 0) return [...list, question];
        const next = [...list];
        next[index] = question;
        return next;
      });
    });

    const appendMessage = (message: Message) => {
      setState("messages", message.projectId, (list = []) => {
        const index = list.findIndex((existing) => existing.id === message.id);
        if (index < 0) return [...list, message];
        const next = [...list];
        next[index] = message;
        return next;
      });
    };
    await bind("message:appended", (message) => {
      batch(() => {
        if (message.author === "agent") setState("streaming", message.projectId, "");
        appendMessage(message);
      });
    });
    await bind("message:receipt", ({ projectId, messageId, status }) => {
      // A path setter cannot descend through a missing project record. Replace
      // that record instead, creating it when the first receipt arrives.
      setState("messageReceipts", projectId, (receipts = {}) => ({
        ...receipts,
        [messageId]: status,
      }));
    });
    await bind("moderation:blocked", appendMessage);

    const upsertTask = (task: RunningTask) => {
      setState("running", task.projectId, (list = []) => {
        const index = list.findIndex((existing) => existing.toolCallId === task.toolCallId);
        if (index < 0) return [...list, task];
        const next = [...list];
        next[index] = task;
        return next;
      });
    };
    await bind("task:started", (task) => {
      batch(() => {
        upsertTask(task);
        touchRunStatus(task.projectId, `running ${task.name}…`);
      });
    });
    await bind("task:progress", upsertTask);

    await bind("task:finished", (entry) => {
      batch(() => {
        /*
         * Matched on identity, never on label. Two shell commands, two reads of
         * the same file or two calls to the same MCP tool share a label, and
         * removing by label would clear all of them when the first finished —
         * taking the Stop buttons and the running count with it.
         *
         * With no id there is nothing to correlate, so nothing is removed: a
         * stale row is recoverable, a wrongly cancelled one is not.
         */
        if (entry.toolCallId !== null) {
          setState("running", entry.projectId, (list = []) =>
            list.filter((task) => task.toolCallId !== entry.toolCallId),
          );
        }
        setState("taskLog", entry.projectId, (list = []) => [entry, ...list]);
        setState("logTotals", entry.projectId, (total = 0) => total + 1);
        touchRunStatus(entry.projectId, "working…");
      });
    });

    /*
     * Appended and capped at the same ceiling Rust keeps, so a long run cannot
     * grow the store without bound. The newest line is the one worth keeping,
     * so the oldest goes first.
     */
    await bind("agent:io", (entry) => {
      setState("agentIo", entry.projectId, (lines = []) =>
        [...lines, entry].slice(-AGENT_IO_LIMIT),
      );
    });

    await bind("run:rate_limit", (limit) => {
      // A limit replayed from the buffer, or delivered late, can already be
      // spent by the time it lands.
      if (!isLimitLive(limit)) return;
      setState("rateLimits", limit.projectId, (limits = {}) => ({
        ...limits,
        [limit.agent]: limit,
      }));
    });

    await bind("run:rate_limit_cleared", ({ projectId, agent }) => {
      /*
       * Reassign the inner record whole rather than `produce`-deleting the
       * nested agent node. Deleting a *nested* store proxy node (unlike a
       * top-level project key, which purgeProject deletes safely) leaves the
       * reactive graph holding a torn-down node, and the 30s clock's re-read of
       * `state.rateLimits[projectId][agent]` in `tabStatus` then threw
       * "undefined is not an object" every tick. Building the next record and
       * setting it via reconcile never strands a consumer on a deleted proxy;
       * an empty record removes the project key at the top level, the safe way.
       */
      const current = state.rateLimits[projectId];
      if (!current || !(agent in current)) return;
      const next: Record<string, RateLimit> = {};
      for (const [key, value] of Object.entries(current)) {
        if (key !== agent) next[key] = value;
      }
      if (Object.keys(next).length === 0) {
        setState(
          "rateLimits",
          produce((limits) => delete limits[projectId]),
        );
      } else {
        setState("rateLimits", projectId, reconcile(next));
      }
    });

    await bind("run:approval", ({ projectId, approvalId, tool, input }) => {
      batch(() => {
        // Normalize a possibly-missing tool at the boundary: a Codex escalation
        // can omit it, and a bare `undefined` reaching the card crashed the
        // render, hiding the very question the run is blocked on.
        setState("pendingApprovals", projectId, { approvalId, tool: tool ?? "", input });
        touchRunStatus(projectId, "waiting for your approval");
      });
    });

    await bind("run:approval_resolved", ({ projectId }) => {
      batch(() => {
        setState(
          "pendingApprovals",
          produce((pending) => delete pending[projectId]),
        );
        touchRunStatus(projectId, "working…");
      });
    });

    await bind("run:accepted", ({ projectId, agent, model, permission }) => {
      touchRunStatus(projectId, "waiting for the agent…", { agent, model, permission });
    });

    await bind("run:inject_failed", ({ projectId, messageId, body }) => {
      // The turn settled before the interruption reached it. The transcript
      // already shows the words; queue that exact row so a fresh turn hears it
      // without appending the same user message a second time.
      if (!(state.queued[projectId] ?? []).some((prompt) => prompt.messageId === messageId)) {
        enqueue(projectId, body, "busy", undefined, messageId);
      }
    });

    /*
     * A conversation being rewritten. Only a compaction this window asked for
     * gets the status line and the queue: the CLI's own mid-turn compaction is
     * reported by the run that is already showing one, and taking that run's
     * status line away to say "compacting" would leave it with nothing when the
     * compaction finished and the answer carried on.
     */
    await bind("run:compaction", ({ projectId, agent, driver, phase }) => {
      if (driver !== "command") return;
      if (phase !== "finished") {
        /*
         * Both in-flight phases hold the session, and both say which one they
         * are. The note-taking pass is the slow half — it is a whole turn
         * against a full context window — so labelling it "compacting" would
         * leave the user watching a held composer through the longest part of
         * the operation with the wrong explanation for it.
         */
        batch(() => {
          setState("compacting", projectId, true);
          touchRunStatus(
            projectId,
            phase === "learning"
              ? "learning what to keep before compacting — please wait"
              : "compacting — the session is busy, please wait",
            {
              agent,
              model:
                state.tabs.find((tab) => tab.projectId === projectId && tab.agent === agent)
                  ?.model ?? "",
              permission:
                state.tabs.find((tab) => tab.projectId === projectId && tab.agent === agent)
                  ?.permission ?? "read_only",
            },
          );
        });
        return;
      }
      batch(() => {
        setState(
          "compacting",
          produce((busy) => delete busy[projectId]),
        );
        setState(
          "runStatus",
          produce((status) => delete status[projectId]),
        );
      });
      // Same cue as `run:stopped`, and the same beat of delay: the slot is
      // released as this run unwinds, a moment after the event goes out.
      if ((state.queued[projectId] ?? []).length > 0) {
        window.setTimeout(() => void flushQueue(projectId, 0), 250);
      }
    });

    await bind("run:text", ({ projectId, delta }) => {
      batch(() => {
        setState("streaming", projectId, (current = "") => current + delta);
        touchRunStatus(projectId, "writing…");
      });
    });

    await bind("run:thinking", ({ projectId }) => {
      touchRunStatus(projectId, "thinking…");
    });

    await bind("run:persisted", ({ projectId, chars }) => {
      setState("runStatus", projectId, (current) => ({
        ...runIdentity(projectId, current),
        startedAt: current?.startedAt ?? Date.now(),
        activity: current?.activity ?? "working…",
        liveTokens: current?.liveTokens ?? null,
        contextTokens: current?.contextTokens ?? null,
        contextWindow: current?.contextWindow ?? null,
        persistedChars: chars,
      }));
    });

    await bind("run:commands", ({ projectId, agent, all, skills }) => {
      // Same missing-parent case as the first receipt above.
      setState("commands", projectId, (commands = {}) => ({
        ...commands,
        [agent]: { all, skills },
      }));
    });

    await bind("run:usage", ({ projectId, tokens, contextTokens, contextWindow }) => {
      setState("runStatus", projectId, (current) => ({
        ...runIdentity(projectId, current),
        startedAt: current?.startedAt ?? Date.now(),
        activity: current?.activity ?? "working…",
        persistedChars: current?.persistedChars ?? 0,
        liveTokens: tokens,
        // Held rather than overwritten with a null: an agent that reports the
        // window once and the tokens thereafter would otherwise blank it.
        contextTokens: contextTokens ?? current?.contextTokens ?? null,
        contextWindow: contextWindow ?? current?.contextWindow ?? null,
      }));
    });

    await bind("run:stopped", ({ projectId, agent, model, permission, stop, exitCode }) => {
      /*
       * The task manager's session id is recorded at `Event::Started`, but
       * with no project row there is no `project:updated` to carry it here —
       * so it is re-asked when the run lands.
       */
      if (projectId === TASK_MANAGER_ID) {
        void client()
          .getTaskManager()
          .then((tm) => setState("taskManagerSession", tm.sessionId))
          .catch((cause) =>
            log.warn(`could not refresh the task manager session: ${describeError(cause)}`),
          );
      }
      batch(() => {
        setState("running", projectId, []);
        setState("streaming", projectId, "");
        setState(
          "runStatus",
          produce((status) => delete status[projectId]),
        );
        // A question the run can no longer hear the answer to.
        setState(
          "pendingApprovals",
          produce((pending) => delete pending[projectId]),
        );

        /*
         * A failed run has to say so in the transcript. Clearing the spinner
         * and leaving nothing behind is what made a failed first prompt look
         * like the app simply ignored it. Deliberate cancellation is different:
         * it is the normal stop/yield path, and the backend has already kept
         * any partial reply and usage it received.
         */
        if (stop !== "completed" && stop !== "canceled") {
          appendMessage({
            id: `run-error-${Date.now()}`,
            projectId,
            itemId: null,
            author: "agent",
            agent,
            moderation: null,
            model,
            permission,
            usage: null,
            stop,
            exitCode,
            body: `The run stopped: ${stop}`,
            createdAt: new Date().toISOString(),
          });
        }
      });
      /*
       * The slot just freed is the queue's cue. Delayed a beat: `run:stopped`
       * is emitted from inside the run's own teardown, a moment before the
       * backend actually releases the one-run-per-project slot, so an
       * immediate send can still be refused. `flushQueue` retries on that.
       */
      if ((state.queued[projectId] ?? []).length > 0) {
        window.setTimeout(() => void flushQueue(projectId, 0), 250);
      }
    });
  }

  function upsertProject(project: Project): void {
    setState(
      produce((draft) => {
        const index = draft.projects.findIndex((existing) => existing.id === project.id);
        if (index < 0) draft.projects.push(project);
        else draft.projects[index] = project;

        /*
         * Kept sorted so the array agrees with `order` at all times.
         * `listProjects` returns them sorted, so without this a reorder made
         * during a session leaves the two disagreeing until the next restart
         * quietly fixes it — the kind of difference that only shows up in the
         * one place nobody thought to sort.
         */
        draft.projects.sort((a, b) => a.order - b.order);

        const tab = draft.tabs.find((candidate) => candidate.key === project.id);
        if (tab) tab.label = project.name;
      }),
    );
  }

  onCleanup(() => {
    for (const unlisten of unlisteners) unlisten();
  });

  // — tabs ————————————————————————————————————————————————————————

  function focus(key: string): void {
    if (!state.tabs.some((tab) => tab.key === key)) return;
    batch(() => {
      setState("activeKey", key);
      setPrefs("lastTabKey", key);
    });
  }

  /**
   * Step through the strip in its current visual order, wrapping at both ends.
   *
   * Index-based on `state.tabs`, which *is* the strip order — so a tab dragged
   * to a new position is immediately in that position for cycling too, with
   * nothing to keep in step.
   */
  function cycleTab(delta: number): void {
    const index = state.tabs.findIndex((tab) => tab.key === state.activeKey);
    if (index < 0 || state.tabs.length < 2) return;
    const count = state.tabs.length;
    focus(state.tabs[(index + delta + count) % count].key);
  }

  /** Move a tab within the strip. Home is index 0 and stays there. */
  function moveTab(key: string, toIndex: number): void {
    const from = state.tabs.findIndex((tab) => tab.key === key);
    if (from <= 0) return;
    const to = Math.min(Math.max(toIndex, 1), state.tabs.length - 1);
    if (from === to) return;
    setState("tabs", (tabs) => {
      const next = [...tabs];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  /**
   * Persist the strip order, once, when a drag ends.
   *
   * Only the project run is persistable — `Project.order` is a real field, and
   * `listProjects` returns them sorted by it, so the order survives a restart.
   * Draft and Settings tabs are window state and keep their place only for as
   * long as they are open.
   */
  async function commitTabOrder(): Promise<void> {
    const ids = state.tabs
      .filter((tab) => tab.kind === "project" && tab.projectId)
      .map((tab) => tab.projectId as string);
    if (ids.length > 1) await client().reorderProjects(ids);
  }

  function openProject(projectId: string): void {
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) return;
    if (!state.tabs.some((tab) => tab.key === projectId)) {
      setState("tabs", (tabs) => [...tabs, projectTab(project)]);
    }
    focus(projectId);
  }

  /** The gear opens Settings as a real tab you can leave open — never a modal. */
  function openSettings(): void {
    if (!state.tabs.some((tab) => tab.kind === "settings")) {
      setState("tabs", (tabs) => [
        ...tabs,
        { ...HOME_TAB, key: "settings", kind: "settings", label: "Settings" },
      ]);
    }
    focus("settings");
  }

  /** The gauge opens Analytics as a real tab, the same way the gear opens Settings. */
  function openAnalytics(): void {
    if (!state.tabs.some((tab) => tab.kind === "analytics")) {
      setState("tabs", (tabs) => [
        ...tabs,
        { ...HOME_TAB, key: "analytics", kind: "analytics", label: "Analytics" },
      ]);
    }
    focus("analytics");
  }

  /** One draft at a time: a second "+" focuses the Untitled tab already open. */
  function openDraft(): void {
    const existing = state.tabs.find((tab) => tab.kind === "draft");
    if (existing) {
      focus(existing.key);
      return;
    }
    const key = `draft-${Date.now()}`;
    const agent = defaultAgent();
    setState("tabs", (tabs) => [
      ...tabs,
      {
        key,
        kind: "draft",
        projectId: null,
        label: "Untitled",
        agent,
        model: defaultModel(),
        effort: defaultEffort(),
        extraThinking: prefs.lastExtraThinking,
        permission: compatiblePermission(
          state.agents,
          agent,
          state.settings?.defaultPermission ?? "read_only",
        ),
        status: "quiet",
      },
    ]);
    focus(key);
  }

  function closeTab(key: string): void {
    if (key === "home") return; // Home is not closable.
    const index = state.tabs.findIndex((tab) => tab.key === key);
    if (index < 0) return;
    batch(() => {
      setState("tabs", (tabs) => tabs.filter((tab) => tab.key !== key));
      if (state.activeKey === key) {
        // Fall back to the tab on the left, which is where the eye already is.
        focus(state.tabs[Math.max(0, index - 1)]?.key ?? "home");
      }
    });
  }

  /**
   * Forget a project completely.
   *
   * The store keys six collections by project id. Dropping the project and its
   * tab while leaving those behind leaks, and worse, lets stale rows resurface
   * if an id is ever reused or a request that was already in flight lands after
   * the delete.
   */
  function purgeProject(projectId: string): void {
    batch(() => {
      setState("projects", (projects) => projects.filter((project) => project.id !== projectId));
      // Every per-project record, not a subset: leaving some behind let the
      // record key-sets diverge, so a value could be absent under a key another
      // record still had — which is how window-wide `Object.values(...)` reads
      // met an undefined value. Delete top-level keys only (nested-node deletes
      // strand the reactive proxy; see `run:rate_limit_cleared`).
      setState(
        produce((draft) => {
          delete draft.items[projectId];
          delete draft.messages[projectId];
          delete draft.messageReceipts[projectId];
          delete draft.running[projectId];
          delete draft.taskLog[projectId];
          delete draft.logTotals[projectId];
          delete draft.rateLimits[projectId];
          delete draft.agentIo[projectId];
          delete draft.streaming[projectId];
          delete draft.pullRequests[projectId];
          delete draft.questions[projectId];
          delete draft.pendingApprovals[projectId];
          delete draft.runStatus[projectId];
          delete draft.queued[projectId];
          delete draft.compacting[projectId];
          delete draft.commands[projectId];
        }),
      );
      closeTab(projectId);
    });
  }

  /**
   * Model and posture are per tab and sticky until Settings contradicts them.
   *
   * Deliberately does not write back to `UiPrefs`. A per-tab override is a
   * choice about *this* tab, and letting it seed the next one is what made
   * Settings look ignored.
   */
  /**
   * Move every tab off a model Settings no longer offers.
   *
   * Settings is authoritative: disabling a model withdraws it everywhere, not
   * just from the menu. A tab left pointing at a withdrawn model would show it
   * in the pill while the menu could not express it, and the next message would
   * go out under a model the user had just removed.
   *
   * Deliberately only touches tabs that *conflict*. A tab on a model that is
   * still enabled keeps it, because the per-tab override is a real choice and
   * editing an unrelated setting should not silently reset it.
   */
  function reconcileTabModels(settings: GlobalSettings): void {
    const defaultAgent = settings.defaultAgent === "codex" ? "codex" : "claude";
    const selection = settings.models[defaultAgent];
    if (!selection || selection.enabled.length === 0) return;

    state.tabs.forEach((tab, index) => {
      /*
       * A draft has no history and is not a project yet, so it tracks the
       * defaults outright: model, posture and effort. Changing a default with
       * an Untitled tab open and finding it unchanged reads as the setting
       * having been ignored, which is what it looked like.
       */
      if (tab.kind === "draft") {
        setState("tabs", index, {
          agent: defaultAgent,
          model: selection.default,
          permission: compatiblePermission(state.agents, defaultAgent, settings.defaultPermission),
          effort: settings.defaultEffort,
        });
        return;
      }

      /*
       * A project keeps its per-tab choice, and only moves when the model it is
       * on has actually been withdrawn. An unrelated settings edit must not
       * silently reset a deliberate override.
       */
      const tabSelection = settings.models[tab.agent];
      if (isProjectAgent(tab.agent) && tabSelection?.enabled.includes(tab.model)) return;
      setState("tabs", index, {
        agent: defaultAgent,
        model: selection.default,
        permission: compatiblePermission(state.agents, defaultAgent, tab.permission),
      });
    });
  }

  function setTabModel(
    key: string,
    agent: Agent,
    model: string,
    permission: Permission,
    effort?: string,
  ): void {
    const index = state.tabs.findIndex((tab) => tab.key === key);
    if (index < 0) return;
    // The selection is frontend state. A sent message records it durably, and
    // reopening the project restores it from that ordered conversation.
    const nextPermission = compatiblePermission(state.agents, agent, permission);
    // Effort only when the caller sent one: the model and permission pills
    // must not clobber a level someone picked a moment ago.
    setState(
      "tabs",
      index,
      effort === undefined
        ? { agent, model, permission: nextPermission }
        : { agent, model, permission: nextPermission, effort },
    );
  }

  /**
   * Flip this tab's "Extra Thinking". Per tab like the model, and the choice is
   * remembered so the next new tab starts the same way. Only Claude acts on it;
   * the composer greys the control out for the other agents.
   */
  function setTabExtraThinking(key: string, enabled: boolean): void {
    const index = state.tabs.findIndex((tab) => tab.key === key);
    if (index < 0) return;
    setState("tabs", index, { extraThinking: enabled });
    setPrefs("lastExtraThinking", enabled);
  }

  // — mutations ————————————————————————————————————————————————————
  //
  // Each of these fires a command and lets the resulting event update the
  // store, so a change made by the agent and one made here land the same way.

  async function createProject(
    firstMessage: string,
    tabKey: string,
    study?: StudyTurnMetadata,
  ): Promise<void> {
    const tab = state.tabs.find((candidate) => candidate.key === tabKey);
    const created = await client().createProject({
      firstMessage,
      agent: tab?.agent,
      model: tab?.model,
      permission: tab?.permission,
      effort: tab?.effort,
      extraThinking: tab?.extraThinking,
      study,
    });
    batch(() => {
      /*
       * The record goes in from the command's own return value, before the tab
       * is converted — not left to the `project:created` event.
       *
       * This is the one mutation the window is allowed to apply optimistically,
       * because it is the tab the user is holding. The event is delivered on a
       * separate hop, so leaving it to arrive first means the tab is already
       * `kind: "project"` while `state.projects` still has nothing under that
       * id, and the tab renders "This project could not be loaded" until it
       * lands. `upsertProject` matches on id, so the event that follows is a
       * no-op rather than a duplicate.
       */
      upsertProject(created.project);

      // The draft becomes the project tab: same position in the strip, so the
      // tab you were typing in is the tab that keeps the conversation. Any tab
      // already holding this project is dropped rather than duplicated.
      setState("tabs", (tabs) =>
        tabs
          .filter((candidate) => candidate.key !== created.project.id)
          .map((candidate) =>
            candidate.key === tabKey
              ? {
                  ...candidate,
                  key: created.project.id,
                  kind: "project" as const,
                  projectId: created.project.id,
                  label: created.project.name,
                }
              : candidate,
          ),
      );
      setState("items", created.project.id, created.items);
      focus(created.project.id);
    });
  }

  /**
   * The status line's anchor: a run exists for this project from now until
   * `run:stopped`. Create-if-missing because every event arm calls this — the
   * first one to land after a send is whichever the agent got to first.
   */
  function runIdentity(
    projectId: string,
    current?: RunStatus,
    incoming?: Pick<RunStatus, "agent" | "model" | "permission">,
  ): Pick<RunStatus, "agent" | "model" | "permission"> {
    if (incoming) return incoming;
    if (current) {
      return {
        agent: current.agent,
        model: current.model,
        permission: current.permission,
      };
    }
    const tab = state.tabs.find((candidate) => candidate.projectId === projectId);
    const message = [...(state.messages[projectId] ?? [])]
      .reverse()
      .find((candidate) => candidate.author === "user" || candidate.author === "agent");
    return {
      agent: tab?.agent ?? message?.agent ?? "claude",
      model: tab?.model ?? message?.model ?? "",
      permission: tab?.permission ?? message?.permission ?? "read_only",
    };
  }

  function touchRunStatus(
    projectId: string,
    activity: string,
    identity?: Pick<RunStatus, "agent" | "model" | "permission">,
  ): void {
    setState("runStatus", projectId, (current) => ({
      ...runIdentity(projectId, current, identity),
      startedAt: current?.startedAt ?? Date.now(),
      persistedChars: current?.persistedChars ?? 0,
      liveTokens: current?.liveTokens ?? null,
      contextTokens: current?.contextTokens ?? null,
      contextWindow: current?.contextWindow ?? null,
      activity,
    }));
  }

  /** A run is in flight, so a send now would be refused by the backend. */
  const isBusy = (projectId: string): boolean =>
    projectId in state.runStatus ||
    (state.running[projectId] ?? []).length > 0 ||
    (state.streaming[projectId] ?? "") !== "";

  /**
   * The raw dispatch, on the tab's model and posture. Throws on any refusal.
   * No optimistic `runStatus` here: the backend's `run:accepted` starts the
   * status line, so a backend that fakes no run (the mock) shows no run.
   */
  const dispatch = async (
    projectId: string,
    body: string,
    study?: StudyTurnMetadata,
    retryMessageId?: string,
  ): Promise<void> => {
    const tab = state.tabs.find((candidate) => candidate.projectId === projectId);
    await client().sendMessage({
      projectId,
      body,
      retryMessageId,
      agent: tab?.agent,
      model: tab?.model,
      permission: tab?.permission,
      // The tab's effort, which was being dropped here: every run reached the
      // agent with `effort=<none>` while the composer showed a level selected.
      effort: tab?.effort,
      extraThinking: tab?.extraThinking,
      study,
    });

    /*
     * The next accepted user message is the answer to every standing
     * `@agency:ask` in this conversation. Clear the local rows at that exact
     * boundary, not when the agent eventually finishes its reply: keeping the
     * red blocked dot for another multi-minute turn says the owner still owes
     * an answer that is already visible in the transcript.
     *
     * Rust makes the same transition durable and emits canonical updates. This
     * optimistic local step covers the IPC gap between acceptance and those
     * events; a refused send never reaches it, so questions stay open when the
     * drafted answer was not actually accepted.
     */
    setState("questions", projectId, (questions = []) =>
      questions.map((question) => (question.answered ? question : { ...question, answered: true })),
    );
  };

  /** Hold a prompt, and say what it is waiting for. */
  function enqueue(
    projectId: string,
    body: string,
    reason: QueueReason,
    study?: StudyTurnMetadata,
    messageId?: string,
  ): void {
    setState("queued", projectId, (waiting = []) => [
      ...waiting,
      { body, reason, study, messageId },
    ]);
  }

  const send = async (
    projectId: string,
    body: string,
    study?: StudyTurnMetadata,
  ): Promise<void> => {
    /*
     * A compaction is the one busy state worth checking *before* dispatching.
     * It is not a turn that can be interrupted — the words would go into a run
     * that is rewriting the session and reading nobody — and it is slow enough
     * that a message vanishing into it looks like the app dropping it.
     */
    if (state.compacting[projectId]) {
      enqueue(projectId, body, "compacting", study);
      return;
    }

    const runningAgent = state.runStatus[projectId]?.agent;
    if (
      isBusy(projectId) &&
      runningAgent !== undefined &&
      !capabilitiesFor(runningAgent)?.liveFollowUp
    ) {
      enqueue(projectId, body, "busy", study);
      return;
    }

    /*
     * Otherwise sent regardless of a live run: the backend delivers a mid-run
     * message *into* the open turn (0.3.6's `Run::send`), so typing a
     * correction interrupts rather than waits. The refusal below only remains
     * for the mock (which fakes no run) and the settle-race — there the store
     * queues, and the run's stop flushes. Either way the words are never handed
     * back.
     */
    try {
      await dispatch(projectId, body, study);
    } catch (cause) {
      const reason = queueReason(cause);
      if (reason) {
        enqueue(projectId, body, reason, study);
        return;
      }
      throw cause;
    }
  };

  /**
   * Send the oldest queued prompt, once the slot frees.
   *
   * Retries with backoff because `run:stopped` slightly precedes the slot
   * actually opening; after the attempts run out the prompt goes back to the
   * front of the queue, still visible above the composer rather than lost.
   */
  async function flushQueue(projectId: string, attempt: number): Promise<void> {
    const waiting = state.queued[projectId] ?? [];
    const next = waiting[0];
    if (next === undefined) return;
    if (isBusy(projectId)) return; // a newer run took the slot; its stop will re-cue
    setState("queued", projectId, waiting.slice(1));
    try {
      await dispatch(projectId, next.body, next.study, next.messageId);
    } catch (cause) {
      setState("queued", projectId, (rest = []) => [next, ...rest]);
      if (attempt < 4) {
        window.setTimeout(() => void flushQueue(projectId, attempt + 1), 500 * 2 ** attempt);
      } else {
        log.error(`could not send the queued prompt: ${describeError(cause)}`);
      }
    }
  }

  /**
   * A prompt for the Home task manager, on its own settings.
   *
   * Not `send`: there is no tab to read a model from, and the task manager
   * deliberately runs on `GlobalSettings.taskManager` — a list keeper running
   * unattended should not be silently billed at the prompt's model.
   *
   * Provider, model, effort and posture all come from the Task Manager block.
   * Its conversation is separate from project tabs, including one native
   * session per provider.
   */
  const sendTaskPrompt = async (body: string, study?: StudyTurnMetadata): Promise<void> => {
    const taskManager = state.settings?.taskManager;
    await client().sendMessage({
      projectId: TASK_MANAGER_ID,
      body,
      agent: taskManager?.agent,
      model: taskManager?.model,
      permission: taskManager?.permission,
      effort: taskManager?.effort,
      study,
    });
  };

  const actions = {
    retryInit,
    focus,
    cycleTab,
    moveTab,
    commitTabOrder,
    openProject,
    openSettings,
    openAnalytics,
    openDraft,
    closeTab,
    setTabModel,
    setTabExtraThinking,
    createProject,
    send,
    sendTaskPrompt,
    async resetTaskManager() {
      await client().resetTaskManager();
      setState("taskManagerSession", null);
    },
    deleteProject: (id: string) => client().deleteProject(id),
    renameProject: (id: string, name: string) => client().renameProject(id, name),
    getIoPersist: (projectId: string) => client().getIoPersist(projectId),
    setIoPersist: (projectId: string, enabled: boolean) =>
      client().setIoPersist(projectId, enabled),
    refreshQuota,
    refreshClaudeUsage,
    purgeProject,
    setProjectStatus: (id: string, status: ProjectStatus) => client().setProjectStatus(id, status),
    setProjectPinned: (id: string, pinned: boolean) => client().setProjectPinned(id, pinned),
    setProjectModerator: (id: string, enabled: boolean) =>
      client().setProjectModerator(id, enabled),
    addDir: (projectId: string, path: string) => client().addDir(projectId, path),
    removeDir: (projectId: string, path: string) => client().removeDir(projectId, path),
    createItem: (projectId: string, title: string) => client().createItem(projectId, title),
    reorderItems: (projectId: string, ids: string[]) => client().reorderItems(projectId, ids),
    setItemStatus: (id: string, status: ProjectStatus) => client().setItemStatus(id, status),
    updateItem: (id: string, title: string) => client().updateItem(id, title),
    setItemIssue: (id: string, url: string) => client().setItemIssue(id, url),
    deleteItem: (id: string) => client().deleteItem(id),
    chooseAttachments: () => client().chooseAttachments(),
    dismissPullRequest: (id: string) => client().dismissPullRequest(id),
    reviewPullRequest: (projectId: string, url: string, agent: Agent) =>
      client().reviewPullRequest(projectId, url, agent),
    refreshPullRequest: (id: string) => client().refreshPullRequest(id),
    answerQuestion: (id: string, answered = true) => client().answerQuestion(id, answered),
    /** Drop one queued prompt — second thoughts are allowed while it waits. */
    removeQueued(projectId: string, index: number) {
      setState("queued", projectId, (waiting = []) =>
        waiting.filter((_, position) => position !== index),
      );
    },
    resolveModeration: (messageId: string, approve: boolean) =>
      client().resolveModeration(messageId, approve),
    resolveApproval: (projectId: string, approvalId: string, allow: boolean, remember?: boolean) =>
      client().resolveApproval(projectId, approvalId, allow, remember),
    listApprovalRules: (projectId: string) => client().listApprovalRules(projectId),
    clearApprovalRules: (projectId: string) => client().clearApprovalRules(projectId),
    getCostSummary: () => client().getCostSummary(),
    getUsageAnalytics: () => client().getUsageAnalytics(),
    getBuildInfo: () => client().getBuildInfo(),
    checkForUpdate,
    installUpdate: () => client().installUpdate(),
    quitApp: () => client().quitApp(),
    relaunchApp: () => client().relaunchApp(),
    cancelTask: (toolCallId: string) => client().cancelTask(toolCallId),
    cancelRun: (projectId: string) => client().cancelRun(projectId),
    /*
     * Left to reject. The composer shows the agent's own reason, and the
     * reasons are answers rather than faults: too short to summarise, or a run
     * already holding the slot. Swallowing them here would leave the user
     * looking at an unchanged transcript with no explanation.
     */
    compactProject: (projectId: string, agent: Agent) => client().compactProject(projectId, agent),
    /*
     * Read on demand rather than held in the store: the notes change once per
     * compaction, and the only screen that shows them is the panel section that
     * asks for them. Keeping a copy in state would mean another thing to
     * invalidate for no reader.
     */
    getCheckpoints: (projectId: string) => client().getCheckpoints(projectId),
    setCheckpoints: (projectId: string, enabled: boolean) =>
      client().setCheckpoints(projectId, enabled),
    getProjectConcise: (projectId: string) => client().getProjectConcise(projectId),
    setProjectConcise: (projectId: string, enabled: string) =>
      client().setProjectConcise(projectId, enabled),
    getProjectVerbosity: (projectId: string) => client().getProjectVerbosity(projectId),
    setProjectVerbosity: (projectId: string, verbosity: string) =>
      client().setProjectVerbosity(projectId, verbosity),
    resetProjectSession: (projectId: string, agent: string, force?: boolean) =>
      client().resetProjectSession(projectId, agent, force),
    adoptSession: (projectId: string, agent: string, sessionId: string) =>
      client().adoptSession(projectId, agent, sessionId),
    getProjectNotes: (projectId: string) => client().getProjectNotes(projectId),
    setProjectNotes: (projectId: string, notes: string) =>
      client().setProjectNotes(projectId, notes),
    async clearTaskLog(projectId: string) {
      await client().clearTaskLog(projectId);
      batch(() => {
        setState("taskLog", projectId, []);
        setState("logTotals", projectId, 0);
      });
    },
    /**
     * Settings autosave, and each response replaces the whole record — so two
     * quick changes racing means the slower one wins and silently reverts the
     * other. Writes are numbered and a stale response is dropped.
     */
    async saveSettings(patch: Parameters<AgencyZeroApi["setSettings"]>[0]) {
      const ticket = ++settingsWrite;
      const next = await client().setSettings(patch);
      if (ticket !== settingsWrite) return;
      batch(() => {
        setState("settings", next);
        reconcileTabModels(next);
      });
      if (patch.taskManager) {
        const taskManager = await client().getTaskManager();
        if (ticket === settingsWrite) setState("taskManagerSession", taskManager.sessionId);
      }
      // The record is the only source for the palette, so the document follows
      // whatever came back rather than what was optimistically sent — a
      // rejected or clamped theme shows as the value that was actually stored.
      applyTheme(next.theme);
    },
    getStudySummary: () => client().getStudySummary(),
    exportStudyEvents: () => client().exportStudyEvents(),
    clearStudyEvents: () => client().clearStudyEvents(),
    async recheckAgents() {
      setState("agents", reconcile(await client().listAgentStatus(true)));
    },
    /**
     * Re-read the catalogues, asking each CLI to enumerate where it can.
     *
     * Only Codex answers today, so this is mostly a Codex refresh; the other two
     * come back on their compiled lists with `discovered: false`, which the
     * Settings provenance line reports honestly rather than hiding.
     */
    /**
     * Point future launches at a different data directory, or at the default
     * with `null`. Re-reads afterwards, which is what surfaces the change: the
     * tables stay open where they are, so only the `pending` half of the answer
     * moves until the next launch.
     */
    async setDataLocation(path: string | null) {
      await client().setDataLocation(path);
      setState("dataLocation", await client().getDataLocation());
    },
    /**
     * Choose that directory with the OS picker.
     *
     * A cancelled picker writes nothing. Distinguishing it from a choice is the
     * whole reason the command answers `null` rather than an empty string.
     */
    async chooseDataLocation() {
      const picked = await client().chooseDataDirectory();
      if (picked) await actions.setDataLocation(picked);
    },
    /** The native folder panel, for a project's working directories. */
    chooseProjectDirectory() {
      return client().chooseProjectDirectory();
    },
    /** Open a link in the browser. See the Rust command for the scheme rule. */
    openExternal(url: string) {
      return client().openExternal(url);
    },
    /** How much disk each table holds. Read on demand; nothing caches it. */
    listTableSizes() {
      return client().listTableSizes();
    },
    /** Create the workspace directory, then re-read so the row updates. */
    async createWorkspaceRoot() {
      setState("workspaceRoot", await client().createWorkspaceRoot());
    },
    async refreshModels() {
      setState("models", reconcile(await client().listModels(true)));
    },
    /**
     * Add or remove a model from an agent's picker.
     *
     * Holds the two invariants that keep a picker non-empty: the last enabled
     * model cannot be removed, and removing the default promotes another entry
     * rather than leaving `default` pointing at something the picker no longer
     * offers. Both are enforced here instead of in the UI so a keyboard path or
     * a future caller cannot route around them.
     */
    async toggleModel(agent: Agent, modelId: string, enabled: boolean) {
      const current = state.settings?.models[agent];
      if (!current) return;

      const next = enabled
        ? [...new Set([...current.enabled, modelId])]
        : current.enabled.filter((id) => id !== modelId);
      if (next.length === 0) return;

      // Order the selection by the catalogue rather than by click order, so the
      // picker reads in the vendor's ranking however it was assembled.
      const catalogue = state.models.find((entry) => entry.agent === agent);
      const ordered = catalogue
        ? catalogue.models.filter((model) => next.includes(model.id)).map((model) => model.id)
        : next;

      await actions.saveSettings({
        models: {
          [agent]: {
            enabled: ordered,
            default: ordered.includes(current.default) ? current.default : ordered[0],
          },
        },
      });
    },
    /** Preselect a model. Enabling it first, since a default must be offered. */
    async setDefaultModel(agent: Agent, modelId: string) {
      const current = state.settings?.models[agent];
      if (!current) return;
      /*
       * Copied, never passed through. `current.enabled` is a store proxy, and
       * sending it back as part of a patch puts the store inside its own next
       * value, which hangs rather than failing.
       */
      const enabled = current.enabled.includes(modelId)
        ? [...current.enabled]
        : [...current.enabled, modelId];
      await actions.saveSettings({ models: { [agent]: { enabled, default: modelId } } });
    },
  };

  return {
    state,
    actions,
    activeTab,
    activeProject,
    tabStatus,
    isLive,
    effortsFor,
    capabilitiesFor,
    permissionsFor,
    itemsFor,
    openItemCount,
    promptModels,
    init,
  };
}

export type Workspace = ReturnType<typeof createWorkspace>;

const WorkspaceContext = createContext<Workspace>();

export function WorkspaceProvider(
  props: ParentProps,
): ReturnType<typeof WorkspaceContext.Provider> {
  const workspace = createWorkspace();
  void workspace.init();
  return <WorkspaceContext.Provider value={workspace}>{props.children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return workspace;
}

/** A ticking clock for the elapsed counters, shared by every running-task row. */
export function useNow(intervalMs = 1000): Accessor<number> {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), intervalMs);
  onCleanup(() => clearInterval(timer));
  return now;
}
