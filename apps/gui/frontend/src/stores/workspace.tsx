import {
  type Accessor,
  batch,
  createContext,
  createMemo,
  createSignal,
  onCleanup,
  type ParentProps,
  useContext,
} from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import type { AgencyZeroApi, AppEvents, Unlisten } from "~/api";
import { selectApi } from "~/api";
import { describeError, installGlobalErrorLogging, log } from "~/lib/log";
import { prefs, setPrefs } from "~/stores/prefs";
import type {
  Agent,
  AgentIoEntry,
  AgentModels,
  AgentStatus,
  DataLocation,
  GlobalSettings,
  Message,
  PendingApproval,
  Permission,
  Project,
  ProjectItem,
  ProjectStatus,
  QuotaReport,
  RateLimit,
  RunningTask,
  Tab,
  TabStatus,
  TaskLogEntry,
  WorkspaceRoot,
} from "~/types";

const TASK_LOG_PAGE = 40;

/** Matches `MAX_IO_ENTRIES` in `projects.rs`; see the `agent:io` handler. */
const AGENT_IO_LIMIT = 500;

const FALLBACK_EFFORT = "high";

type WorkspaceState = {
  projects: Project[];
  items: Record<string, ProjectItem[]>;
  messages: Record<string, Message[]>;
  running: Record<string, RunningTask[]>;
  taskLog: Record<string, TaskLogEntry[]>;
  logTotals: Record<string, number>;
  /** The raw exchange with the agent, per project. Diagnostic, not persisted. */
  agentIo: Record<string, AgentIoEntry[]>;
  rateLimits: Record<string, RateLimit>;
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
  /** Where the tables were opened from. Null until boot ends. */
  dataLocation: DataLocation | null;
  /** Where a new project runs. Null until boot ends. */
  workspaceRoot: WorkspaceRoot | null;
  /**
   * Where the account stands. Null until boot ends; a report with
   * `supported: false` is the honest answer, not a missing one.
   */
  quota: QuotaReport | null;
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
  model: "sonnet",
  effort: FALLBACK_EFFORT,
  permission: "read_only",
  status: "quiet",
};

function createWorkspace() {
  const [state, setState] = createStore<WorkspaceState>({
    projects: [],
    items: {},
    messages: {},
    running: {},
    taskLog: {},
    logTotals: {},
    agentIo: {},
    rateLimits: {},
    pendingApprovals: {},
    taskManagerSession: null,
    settings: null,
    agents: [],
    models: [],
    dataLocation: null,
    workspaceRoot: null,
    quota: null,
    streaming: {},
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

  const client = (): AgencyZeroApi => {
    const current = api();
    if (!current) throw new Error("workspace used before the backend was selected");
    return current;
  };

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
     * Only a limit that actually refused something counts as blocked. The
     * provider also emits an "allowed" heartbeat mid-run, and treating that as a
     * limit turned the dot amber on a run that was never restricted.
     *
     * Liveness is checked rather than trusted: a suspended app misses timers, so
     * an entry can outlive its reset time without anything having cleared it.
     */
    const limit = state.rateLimits[projectId];
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

  /**
   * What the prompt's model pill offers, as `{ value, label }` pairs.
   *
   * Claude only: the prompt sends to Claude today, and the Codex and Copilot
   * selections in Settings are collected for the code review UI rather than
   * consumed here. Ordered by the catalogue rather than by the saved selection,
   * so the menu reads in the vendor's own ranking.
   *
   * Empty until boot finishes, which the composer covers by keeping the tab's
   * own model as an option rather than rendering an empty menu.
   */
  const promptModels = createMemo(() => {
    const catalogue = state.models.find((entry) => entry.agent === "claude");
    const enabled = state.settings?.models.claude.enabled ?? [];
    return (catalogue?.models ?? [])
      .filter((model) => enabled.includes(model.id))
      .map((model) => ({ value: model.id, label: model.name }));
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
  function effortsFor(modelId: string): string[] {
    const catalogue = state.models.find((entry) => entry.agent === "claude");
    return catalogue?.models.find((model) => model.id === modelId)?.efforts ?? [];
  }

  function itemsFor(projectId: string): ProjectItem[] {
    return state.items[projectId] ?? [];
  }

  /** The Items badge counts what is left to do, so finished items drop out. */
  function openItemCount(projectId: string): number {
    return itemsFor(projectId).filter((item) => item.status !== "finished").length;
  }

  // — loading ————————————————————————————————————————————————————

  async function loadProject(projectId: string): Promise<void> {
    const backend = client();
    const [items, messages, running, log, io] = await Promise.all([
      backend.listItems(projectId),
      backend.listMessages(projectId),
      backend.listRunningTasks(projectId),
      backend.listTaskLog(projectId, TASK_LOG_PAGE),
      backend.listAgentIo(projectId),
    ]);
    batch(() => {
      setState("items", projectId, reconcile(items));
      setState("messages", projectId, reconcile(messages));
      setState("running", projectId, reconcile(running));
      setState("taskLog", projectId, reconcile(log.entries));
      setState("logTotals", projectId, log.total);
      setState("agentIo", projectId, reconcile(io));
    });
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
      const [projects, settings, agents, models, dataLocation, workspaceRoot, rateLimits] =
        await Promise.all([
          backend.listProjects(),
          backend.getSettings(),
          backend.listAgentStatus(false),
          // Compiled catalogues only. Discovery spawns a CLI per agent, which is
          // too slow to sit in front of the first paint; Settings can ask for it.
          backend.listModels(false),
          backend.getDataLocation(),
          backend.getWorkspaceRoot(),
          backend.listRateLimits(),
        ]);

      batch(() => {
        setState("projects", reconcile(projects));
        setState("settings", settings);
        setState("agents", reconcile(agents));
        setState("models", reconcile(models));
        setState("dataLocation", dataLocation);
        setState("workspaceRoot", workspaceRoot);
        setState(
          "rateLimits",
          // A limit whose reset time has already passed is history, not state.
          Object.fromEntries(
            rateLimits.filter(isLimitLive).map((limit) => [limit.projectId, limit]),
          ),
        );
        // Every project gets a tab, matching the mockup's strip. A project the
        // user closed would be reopened from the Home list.
        setState("tabs", [HOME_TAB, ...projects.map(projectTab)]);
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
  async function refreshQuota(): Promise<void> {
    try {
      setState("quota", await client().listQuota());
    } catch (cause) {
      log.warn(`could not refresh the quota: ${describeError(cause)}`);
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
   * What a new tab starts on: the default agent's default model from Settings.
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

  function defaultModel(): string {
    const settings = state.settings;
    if (!settings) return "";
    return settings.models[settings.defaultAgent]?.default ?? "";
  }

  function projectTab(project: Project): Tab {
    return {
      key: project.id,
      kind: "project",
      projectId: project.id,
      label: project.name,
      model: defaultModel(),
      effort: defaultEffort(),
      permission: state.settings?.defaultPermission ?? "read_only",
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
    await bind("task:started", upsertTask);
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
      setState("rateLimits", limit.projectId, limit);
    });

    await bind("run:rate_limit_cleared", ({ projectId }) => {
      setState(
        "rateLimits",
        produce((limits) => delete limits[projectId]),
      );
    });

    await bind("run:approval", ({ projectId, approvalId, tool, input }) => {
      setState("pendingApprovals", projectId, { approvalId, tool, input });
    });

    await bind("run:approval_resolved", ({ projectId }) => {
      setState(
        "pendingApprovals",
        produce((pending) => delete pending[projectId]),
      );
    });

    await bind("run:text", ({ projectId, delta }) => {
      setState("streaming", projectId, (current = "") => current + delta);
    });

    await bind("run:stopped", ({ projectId, stop, exitCode }) => {
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
        // A question the run can no longer hear the answer to.
        setState(
          "pendingApprovals",
          produce((pending) => delete pending[projectId]),
        );

        /*
         * A run that did not complete has to say so in the transcript. Clearing
         * the spinner and leaving nothing behind is what made a failed first
         * prompt look like the app simply ignoring it.
         */
        if (stop !== "completed") {
          appendMessage({
            id: `run-error-${Date.now()}`,
            projectId,
            itemId: null,
            author: "agent",
            agent: "claude",
            moderation: null,
            model: "",
            permission: "read_only",
            usage: null,
            stop,
            exitCode,
            body: `The run stopped: ${stop}`,
            createdAt: new Date().toISOString(),
          });
        }
      });
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

  /** One draft at a time: a second "+" focuses the Untitled tab already open. */
  function openDraft(): void {
    const existing = state.tabs.find((tab) => tab.kind === "draft");
    if (existing) {
      focus(existing.key);
      return;
    }
    const key = `draft-${Date.now()}`;
    setState("tabs", (tabs) => [
      ...tabs,
      {
        key,
        kind: "draft",
        projectId: null,
        label: "Untitled",
        model: defaultModel(),
        effort: defaultEffort(),
        permission: state.settings?.defaultPermission ?? "read_only",
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
      setState(
        produce((draft) => {
          delete draft.items[projectId];
          delete draft.messages[projectId];
          delete draft.running[projectId];
          delete draft.taskLog[projectId];
          delete draft.logTotals[projectId];
          delete draft.rateLimits[projectId];
          delete draft.agentIo[projectId];
          delete draft.streaming[projectId];
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
    const selection = settings.models[settings.defaultAgent];
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
          model: selection.default,
          permission: settings.defaultPermission,
          effort: settings.defaultEffort,
        });
        return;
      }

      /*
       * A project keeps its per-tab choice, and only moves when the model it is
       * on has actually been withdrawn. An unrelated settings edit must not
       * silently reset a deliberate override.
       */
      if (selection.enabled.includes(tab.model)) return;
      setState("tabs", index, { model: selection.default });
      // The backend keeps per-tab state, so a migration has to reach it too, or
      // the next send would use the model the frontend just moved away from.
      void client().setTabModel(tab.key, selection.default, tab.permission);
    });
  }

  function setTabModel(key: string, model: string, permission: Permission, effort?: string): void {
    const index = state.tabs.findIndex((tab) => tab.key === key);
    if (index < 0) return;
    // Effort only when the caller sent one: the model and permission pills
    // must not clobber a level someone picked a moment ago.
    setState(
      "tabs",
      index,
      effort === undefined ? { model, permission } : { model, permission, effort },
    );
    void client().setTabModel(key, model, permission);
  }

  // — mutations ————————————————————————————————————————————————————
  //
  // Each of these fires a command and lets the resulting event update the
  // store, so a change made by the agent and one made here land the same way.

  async function createProject(firstMessage: string, tabKey: string): Promise<void> {
    const tab = state.tabs.find((candidate) => candidate.key === tabKey);
    const created = await client().createProject({
      firstMessage,
      model: tab?.model,
      permission: tab?.permission,
      effort: tab?.effort,
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

  const send = async (projectId: string, body: string): Promise<void> => {
    const tab = state.tabs.find((candidate) => candidate.projectId === projectId);
    await client().sendMessage({
      projectId,
      body,
      model: tab?.model,
      permission: tab?.permission,
      // The tab's effort, which was being dropped here: every run reached the
      // agent with `effort=<none>` while the composer showed a level selected.
      effort: tab?.effort,
    });
  };

  /**
   * A prompt for the Home task manager, on its own settings.
   *
   * Not `send`: there is no tab to read a model from, and the task manager
   * deliberately runs on `GlobalSettings.taskManager` — a list keeper running
   * unattended should not be silently billed at the prompt's model.
   *
   * `ask`, not `read_only`: read_only silently denies anything outside the
   * working tree, which is how "read that file in ~/code/…" died with the
   * question buried in the I/O panel. Under `ask` the gated call becomes an
   * approval card on Home instead, and Home is where you already are.
   */
  const sendTaskPrompt = async (body: string): Promise<void> => {
    await client().sendMessage({
      projectId: TASK_MANAGER_ID,
      body,
      model: state.settings?.taskManager.model,
      permission: "ask",
      effort: state.settings?.taskManager.effort,
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
    openDraft,
    closeTab,
    setTabModel,
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
    purgeProject,
    setProjectStatus: (id: string, status: ProjectStatus) => client().setProjectStatus(id, status),
    setProjectPinned: (id: string, pinned: boolean) => client().setProjectPinned(id, pinned),
    setProjectModerator: (id: string, enabled: boolean) =>
      client().setProjectModerator(id, enabled),
    addDir: (projectId: string, path: string) => client().addDir(projectId, path),
    removeDir: (projectId: string, path: string) => client().removeDir(projectId, path),
    createItem: (projectId: string, title: string) => client().createItem(projectId, title),
    setItemStatus: (id: string, status: ProjectStatus) => client().setItemStatus(id, status),
    deleteItem: (id: string) => client().deleteItem(id),
    resolveModeration: (messageId: string, approve: boolean) =>
      client().resolveModeration(messageId, approve),
    resolveApproval: (projectId: string, approvalId: string, allow: boolean) =>
      client().resolveApproval(projectId, approvalId, allow),
    getCostSummary: () => client().getCostSummary(),
    relaunchApp: () => client().relaunchApp(),
    cancelTask: (toolCallId: string) => client().cancelTask(toolCallId),
    cancelRun: (projectId: string) => client().cancelRun(projectId),
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
    },
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
     * with `null`. Re-reads afterwards so Settings shows what the next launch
     * will use rather than what is open now.
     */
    async setDataLocation(path: string | null) {
      await client().setDataLocation(path);
      setState("dataLocation", await client().getDataLocation());
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
