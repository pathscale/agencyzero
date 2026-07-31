import type {
  AgentIoEntry,
  AgentModels,
  AgentStatus,
  AvailableUpdate,
  BuildInfo,
  CostSummary,
  CreatedProject,
  DataLocationView,
  GlobalSettings,
  Message,
  PendingApproval,
  Permission,
  Project,
  ProjectItem,
  ProjectStatus,
  PullRequest,
  QuotaReport,
  RateLimit,
  RunningTask,
  TableSize,
  TaskLogEntry,
  TaskManagerState,
  WorkspaceRoot,
} from "~/types";

/**
 * The Tauri surface, as proposed in `design/data-model.html`.
 *
 * Commands are `invoke()` calls; {@link AppEvent} names are `listen()` topics.
 * The agent performs the same mutations the user does, so **every change
 * arrives as an event** — a command's return value updates the caller
 * optimistically, and the event is what keeps the rest of the window honest.
 *
 * Two implementations satisfy this: `./tauri` talks to Rust, `./mock` is an
 * in-memory stand-in. Nothing above this file knows which one it has.
 */
export interface AgencyZeroApi {
  // — Projects ————————————————————————————————————————————————
  listProjects(): Promise<Project[]>;
  /** The name and the initial items are parsed out of the agent's first reply. */
  createProject(input: {
    firstMessage: string;
    model?: string;
    permission?: Permission;
    /** Reasoning effort, as `Request::effort`. Absent means the CLI's default. */
    effort?: string;
  }): Promise<CreatedProject>;
  deleteProject(id: string): Promise<void>;
  /** Stage 3 of the naming design: a manual rename outranks both derived stages. */
  renameProject(id: string, name: string): Promise<Project>;
  setProjectStatus(id: string, status: ProjectStatus): Promise<Project>;
  reorderProjects(ids: string[]): Promise<Project[]>;
  setProjectPinned(id: string, pinned: boolean): Promise<Project>;
  /** Per-session override of the global moderator setting. */
  setProjectModerator(id: string, enabled: boolean): Promise<Project>;
  /** Claude only — `Error::Unsupported` on Codex and Copilot. */
  forkProject(projectId: string, messageId: string): Promise<Project>;
  addDir(projectId: string, path: string): Promise<Project>;
  removeDir(projectId: string, path: string): Promise<Project>;

  // — Items ———————————————————————————————————————————————————
  listItems(projectId: string): Promise<ProjectItem[]>;
  /** Mostly agent-authored from natural language, but the user can add one too. */
  createItem(projectId: string, title: string): Promise<ProjectItem>;
  deleteItem(id: string): Promise<void>;
  setItemStatus(id: string, status: ProjectStatus): Promise<ProjectItem>;
  /** Rewrite one item's title, for the panel's inline edit. */
  updateItem(id: string, title: string): Promise<ProjectItem>;
  reorderItems(projectId: string, ids: string[]): Promise<ProjectItem[]>;

  // — Pull requests ————————————————————————————————————————————
  /** This project's tracked PRs, dismissed ones included; callers filter. */
  listPullRequests(projectId: string): Promise<PullRequest[]>;
  /** Wave one chip away. The row stays; dismissed is view state. */
  dismissPullRequest(id: string): Promise<void>;
  /** Ask gh again — state, diff stats, CI — for the chip's refresh. */
  refreshPullRequest(id: string): Promise<void>;

  // — Conversation ————————————————————————————————————————————
  listMessages(projectId: string): Promise<Message[]>;
  sendMessage(input: {
    projectId: string;
    body: string;
    itemId?: string | null;
    model?: string;
    permission?: Permission;
    /** Reasoning effort, as `Request::effort`. Absent means the CLI's default. */
    effort?: string;
  }): Promise<Message>;
  /** Approve once / Deny on a moderator hold. */
  resolveModeration(messageId: string, approve: boolean): Promise<Message>;

  // — Settings ————————————————————————————————————————————————
  getSettings(): Promise<GlobalSettings>;
  setSettings(patch: DeepPartial<GlobalSettings>): Promise<GlobalSettings>;
  /** Probes the installed CLIs. `recheck` forces a fresh probe. */
  listAgentStatus(recheck: boolean): Promise<AgentStatus[]>;
  /**
   * Every agent's model catalogue, for the Settings picker.
   *
   * `discover` asks each CLI to enumerate rather than trusting the crate's
   * compiled list. Only Codex can answer that today, so the flag improves what
   * it can and leaves the rest on the compiled catalogue with `discovered:
   * false`, rather than failing the whole call for the two agents that cannot
   * be asked.
   */
  listModels(discover: boolean): Promise<AgentModels[]>;
  /**
   * How much disk each table holds, largest first.
   *
   * The store grows unevenly — the task log and the raw I/O are written per
   * tool call and per event — and nothing on screen said so.
   */
  /**
   * Hand a URL to the browser. Only http and https; anything else is refused by
   * Rust, since these URLs arrive inside an agent's reply.
   */
  openExternal(url: string): Promise<void>;
  listTableSizes(): Promise<TableSize[]>;
  /** Where the tables were opened from this launch, and where the next will. */
  getDataLocation(): Promise<DataLocationView>;
  /**
   * Point future launches somewhere else, or at the default with `null`.
   *
   * Takes effect on the next launch and moves nothing: a database cannot be
   * relocated out from under its open handles.
   */
  setDataLocation(path: string | null): Promise<void>;
  /**
   * Open the OS directory picker, to choose the location above.
   *
   * `null` means the user cancelled, which is not a failure. This is a command
   * rather than a `window.prompt` because a Tauri webview draws no prompt at
   * all — the click lands and nothing happens.
   */
  chooseDataDirectory(): Promise<string | null>;
  /**
   * Open the OS file picker, for the composer's Attach button. The chosen
   * paths land in the prompt as text — the agents read file paths in prose,
   * so this is honestly "put the path where the model will see it", not an
   * upload. Empty means the user cancelled, which is not a failure.
   */
  chooseAttachments(): Promise<string[]>;
  /** Where a new project runs, and whether the directory is there yet. */
  getWorkspaceRoot(): Promise<WorkspaceRoot>;
  /** Create it. Explicit, because a settings write should not make directories. */
  createWorkspaceRoot(): Promise<WorkspaceRoot>;

  // — Runs and tasks ——————————————————————————————————————————
  /** The tab's model and posture stick until changed again. */
  setTabModel(tabKey: string, model: string, permission: Permission): Promise<void>;
  /** `Run::cancel` — resolves once the process group is gone. */
  cancelRun(projectId: string): Promise<void>;

  /**
   * Summarise this project's conversation and continue from the summary.
   *
   * A real turn against the agent's own session, so it claims the run slot and
   * is refused while anything else is running. Rejects with the agent's own
   * reason when it will not compact — a conversation too short to summarise is
   * the common one, and is an answer rather than a fault.
   */
  compactProject(projectId: string): Promise<void>;
  listRunningTasks(projectId: string): Promise<RunningTask[]>;
  cancelTask(toolCallId: string): Promise<void>;
  /**
   * Paginated, newest first. `total` is the whole log, not the page — the
   * panel badge reads "91" while holding six rows, so the count has to come
   * back with the page rather than be inferred from it.
   */
  listTaskLog(projectId: string, limit: number, before?: string): Promise<TaskLogPage>;
  /** Whether this project records its raw exchange to the database. */
  getIoPersist(projectId: string): Promise<boolean>;
  /** Turn recording on or off for one project. Off by default; see the Rust doc. */
  setIoPersist(projectId: string, enabled: boolean): Promise<boolean>;
  /** The raw exchange with the agent for this project, oldest first. */
  listAgentIo(projectId: string): Promise<AgentIoEntry[]>;
  /** Where the account stands. See `docs/agent-usage-surface.md`. */
  listQuota(): Promise<QuotaReport>;
  clearTaskLog(projectId: string): Promise<void>;
  /**
   * Rate limits currently in force.
   *
   * `run:rate_limit` announces a *change*; a window opened after one arrived
   * would otherwise show a clear header for a tab that is still blocked. Not
   * in the design's proposed surface — see the frontend README.
   */
  listRateLimits(): Promise<RateLimit[]>;
  /**
   * Answer the approval question a run is blocked on. `allow: false` denies
   * with the stock reason; the turn continues either way. `remember: true`
   * with an allow stores the call's signature so matching asks in this
   * project are answered automatically from then on.
   */
  resolveApproval(
    projectId: string,
    approvalId: string,
    allow: boolean,
    remember?: boolean,
  ): Promise<void>;
  /** The remembered approval signatures for one project. */
  listApprovalRules(projectId: string): Promise<string[]>;
  /** Forget every remembered approval for one project. */
  clearApprovalRules(projectId: string): Promise<void>;
  /** Spend over Settings' ranges, from the usage ledger. Survives project deletion. */
  getCostSummary(): Promise<CostSummary>;
  /** Which commit this binary is and when it was compiled. */
  getBuildInfo(): Promise<BuildInfo>;
  /**
   * The published version, when it is newer than the running one. `null`
   * means genuinely up to date; a check that never reached the CDN rejects
   * instead, so the two cannot be confused.
   */
  checkForUpdate(): Promise<AvailableUpdate | null>;
  /**
   * Download the published bundle over the installed one and restart into
   * it. Refuses while any run is live. Never resolves on success: the
   * process is replaced.
   */
  installUpdate(): Promise<void>;
  /**
   * Drain the store and restart into whatever binary is on disk at the app's
   * own path — the second half of a rebuild. Never resolves: the process is
   * replaced.
   */
  relaunchApp(): Promise<void>;
  /** Where the Home task manager's conversation stands. */
  getTaskManager(): Promise<TaskManagerState>;
  /**
   * Clear the task manager's stored session, so the next prompt starts a
   * fresh conversation. The transcript and collected tasks are left alone.
   */
  resetTaskManager(): Promise<void>;

  // — Events ——————————————————————————————————————————————————
  on<E extends keyof AppEvents>(
    event: E,
    handler: (payload: AppEvents[E]) => void,
  ): Promise<Unlisten>;
}

/** Every broadcast the window listens for, and what rides on it. */
export interface AppEvents {
  "project:created": Project;
  "project:updated": Project;
  "project:deleted": { id: string };
  "item:created": ProjectItem;
  "item:updated": ProjectItem;
  "item:deleted": { id: string; projectId: string };
  /** A tracked PR was recorded, refreshed, or dismissed. Upsert by id. */
  "pr:updated": PullRequest;
  /** author: user | agent | moderator. */
  "message:appended": Message;
  /** The tab dot goes blocked until this one is resolved. */
  "moderation:blocked": Message;
  /** `Event::ToolCall`. */
  "task:started": RunningTask;
  "task:progress": RunningTask;
  /** `Event::ToolResult` — the row leaves Running and lands in the log. */
  "task:finished": TaskLogEntry;
  /** One line of the raw exchange, as it happens. */
  "agent:io": AgentIoEntry;
  /**
   * A delta of the reply, as it arrives. Not persisted and not a Message: the
   * authoritative body is the one that lands as `message:appended` when the run
   * finishes. This is what makes a reply appear while it is being written.
   */
  /**
   * The backend claimed the project's run slot for an accepted send. Starts
   * the transcript's status line; `run:stopped` ends it. The mock never emits
   * this, which is correct — it fakes no run.
   */
  "run:accepted": { projectId: string };
  /**
   * A message sent into a live run could not be delivered — the turn settled
   * in the race window. The words are already in the transcript; this hands
   * them back so the store can queue them for a fresh turn the agent will
   * actually hear.
   */
  "run:inject_failed": { projectId: string; body: string };
  "run:text": { projectId: string; delta: string };
  "run:thinking": { projectId: string; text: string };
  /**
   * The streaming reply was checkpointed to the store, up to this many
   * characters. What the transcript's saved/unsaved dot compares against the
   * streamed length: killing the app now loses only what came after.
   */
  "run:persisted": { projectId: string; chars: number };
  /**
   * The turn's tokens so far, refreshed as each API request inside the turn
   * completes (`Event::Usage`, 0.3.8). Same definition as the header totals:
   * everything the model processed, cache included.
   *
   * The prompt side only. `Event::Usage` withholds `output_tokens` because the
   * mid-turn figure understates badly, so it is left out rather than guessed
   * at, and the number steps up to the final one instead of overshooting it.
   * Cache dominates, so the gap is small.
   *
   * Never sent by agents that report no mid-turn usage — Codex reports none at
   * all — and the estimate from streamed characters covers that case.
   */
  "run:usage": { projectId: string; tokens: number };
  /**
   * What this agent can do, from its own catalogue at run start.
   *
   * `all` includes `skills`; the rest are the CLI's built-in utilities. Read
   * from the agent rather than compiled in, since plugins and installed skills
   * make the set per-machine. Arrives once per run, so a session that has not
   * run yet has none and the composer falls back to what it knows itself.
   */
  "run:commands": { projectId: string; all: string[]; skills: string[] };
  /** A compaction the CLI drove on its own, mid-turn, as the window filled. */
  "run:compaction": {
    projectId: string;
    phase: "started" | "finished";
    ok: boolean;
    error: string | null;
  };
  "run:rate_limit": RateLimit;
  /**
   * The limit has lifted. Without this the header pill and the tab dot stay
   * blocked for the rest of the session, since `resetsAt` passing is not
   * something the window can observe on its own.
   */
  "run:rate_limit_cleared": { projectId: string };
  /**
   * A tool call is waiting on the user. The run is blocked mid-turn until
   * `resolveApproval` answers, so this must render somewhere it will be seen.
   */
  "run:approval": { projectId: string } & PendingApproval;
  /** The question above was answered (by the user, or denied on timeout). */
  "run:approval_resolved": { projectId: string; approvalId: string; allow: boolean };
  "run:stopped": { projectId: string; stop: string; exitCode: number | null };
}

export type AppEvent = keyof AppEvents;

export interface TaskLogPage {
  entries: TaskLogEntry[];
  /** How many entries the project's log holds in total. */
  total: number;
}

export type Unlisten = () => void;

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
