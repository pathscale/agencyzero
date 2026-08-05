import type {
  Agent,
  AgentIoEntry,
  AgentModels,
  AgentStatus,
  AvailableUpdate,
  BuildInfo,
  ClaudeUsage,
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
  Question,
  QuotaReport,
  RateLimit,
  RunningTask,
  StudySummary,
  StudyTurnMetadata,
  TableSize,
  TaskLogEntry,
  TaskManagerState,
  UsageAnalytics,
  WorkspaceRoot,
} from "~/types";

/**
 * How much room a project's kept notes get, in characters.
 *
 * Mirrors `notes::BUDGET` in the Rust, which is the one that binds — the
 * backend clamps whatever it is handed. This copy is what lets the editor show
 * the remaining room *before* saving, rather than silently truncating and
 * leaving the user to notice their last three rules are missing.
 */
export const NOTES_BUDGET = 4_000;

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
    agent?: Agent;
    model?: string;
    permission?: Permission;
    /** Reasoning effort, as `Request::effort`. Absent means the CLI's default. */
    effort?: string;
    /** "Extra Thinking": `false` disables the model's reasoning (Claude only). */
    extraThinking?: boolean;
    study?: StudyTurnMetadata;
  }): Promise<CreatedProject>;
  deleteProject(id: string): Promise<void>;
  /** Stage 3 of the naming design: a manual rename outranks both derived stages. */
  renameProject(id: string, name: string): Promise<Project>;
  setProjectStatus(id: string, status: ProjectStatus): Promise<Project>;
  reorderProjects(ids: string[]): Promise<Project[]>;
  setProjectPinned(id: string, pinned: boolean): Promise<Project>;
  /** Per-session override of the global moderator setting. */
  setProjectModerator(id: string, enabled: boolean): Promise<Project>;
  /** Requires the provider's fork capability; unsupported providers return an error. */
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
  /** Associate the item with a validated GitHub issue URL. */
  setItemIssue(id: string, url: string): Promise<ProjectItem>;
  reorderItems(projectId: string, ids: string[]): Promise<ProjectItem[]>;

  // — Pull requests ————————————————————————————————————————————
  /** This project's tracked PRs, dismissed ones included; callers filter. */
  listPullRequests(projectId: string): Promise<PullRequest[]>;
  /** Wave one chip away. The row stays; dismissed is view state. */
  dismissPullRequest(id: string): Promise<void>;
  /** Ask gh again — state, diff stats, CI — for the chip's refresh. */
  refreshPullRequest(id: string): Promise<void>;
  /** Discover a project's open PRs from its git remotes, even with no rows yet. */
  discoverPullRequests(projectId: string): Promise<void>;
  /** Review a PR headlessly; the result lands inline in the transcript. */
  reviewPullRequest(projectId: string, url: string, agent: Agent): Promise<void>;

  // — Questions ————————————————————————————————————————————————
  /** This project's questions, answered ones included; callers filter. */
  listQuestions(projectId: string): Promise<Question[]>;
  /** Mark a question answered, or reopen it. */
  answerQuestion(id: string, answered: boolean): Promise<void>;

  // — Conversation ————————————————————————————————————————————
  listMessages(projectId: string): Promise<Message[]>;
  sendMessage(input: {
    projectId: string;
    body: string;
    /** Existing transcript row being retried after a rejected live steer. */
    retryMessageId?: string;
    itemId?: string | null;
    agent?: Agent;
    model?: string;
    permission?: Permission;
    /** Reasoning effort, as `Request::effort`. Absent means the CLI's default. */
    effort?: string;
    /** "Extra Thinking": `false` disables the model's reasoning (Claude only). */
    extraThinking?: boolean;
    study?: StudyTurnMetadata;
  }): Promise<Message>;
  /** Approve once / Deny on a moderator hold. */
  resolveModeration(messageId: string, approve: boolean): Promise<Message>;

  // — Settings ————————————————————————————————————————————————
  getSettings(): Promise<GlobalSettings>;
  setSettings(patch: DeepPartial<GlobalSettings>): Promise<GlobalSettings>;
  getStudySummary(): Promise<StudySummary>;
  /** Native save picker; `null` means it was cancelled. */
  exportStudyEvents(): Promise<string | null>;
  clearStudyEvents(): Promise<void>;
  /** Experimental profile only. Fetches usage through Claude Code's managed login. */
  claudeUsage(): Promise<ClaudeUsage>;
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
  /** A working directory for a project. Starts at home, not beside the store. */
  chooseProjectDirectory(): Promise<string | null>;
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
  /** `Run::cancel` — resolves once the process group is gone. */
  cancelRun(projectId: string): Promise<void>;

  /**
   * Summarise this project's conversation and continue from the summary.
   *
   * A real turn against the agent's own session, so it claims the run slot and
   * is refused while anything else is running. A project with no session yet
   * gets one — the command establishes it rather than demanding it. Rejects
   * with the agent's own reason when it will not compact; a conversation too
   * short to summarise is the common one, and is an answer rather than a fault.
   */
  compactProject(projectId: string, agent: Agent): Promise<void>;

  /**
   * What this project's agent keeps across compactions.
   *
   * Empty until a compaction has taken some. These are standing instructions —
   * they ride every turn — so they are readable and writable rather than hidden:
   * an agent that wrote down a wrong rule would otherwise carry it for the life
   * of the project, and the only symptom would be behaviour nobody can account
   * for.
   */
  /**
   * Whether this project samples its knowledge as the context fills.
   *
   * Off by default. Each sample is a whole extra turn against a large
   * conversation, and nothing reads them back to the agent — they are evidence
   * for choosing when to compact, not a feature the agent benefits from.
   */
  getCheckpoints(projectId: string): Promise<boolean>;
  setCheckpoints(projectId: string, enabled: boolean): Promise<boolean>;

  /** Whether this project's turns carry the concise-response instruction. */
  getProjectConcise(projectId: string): Promise<boolean>;
  setProjectConcise(projectId: string, enabled: boolean): Promise<boolean>;

  /** How much per-turn context this project re-sends: "full", "compact" or
   *  "minimal". Trades snapshot detail for input tokens. */
  getProjectVerbosity(projectId: string): Promise<string>;
  setProjectVerbosity(projectId: string, verbosity: string): Promise<void>;

  /** Forget the stored session so the next message starts fresh instead of
   *  resuming — the recovery path for a wedged conversation. Keeps the
   *  transcript; only clears the resume pointer. Rejects while a run is live. */
  resetProjectSession(projectId: string, agent: string): Promise<void>;

  getProjectNotes(projectId: string): Promise<string>;
  /** Returns the text as stored — clamped to the budget, so the editor shows
   *  what the agent will actually be told rather than what was typed. */
  setProjectNotes(projectId: string, notes: string): Promise<string>;
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
  /** Ledger + cache aggregation for the Analytics view. */
  getUsageAnalytics(): Promise<UsageAnalytics>;
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
  /** Drain persistence asynchronously, then exit the native app. */
  quitApp(): Promise<void>;
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
  /** A question was asked or answered. Upsert by id. */
  "question:updated": Question;
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
  "run:accepted": {
    projectId: string;
    agent: Agent;
    model: string;
    permission: Permission;
  };
  /**
   * A message sent into a live run could not be delivered — the turn settled
   * in the race window. The words are already in the transcript; this hands
   * them back so the store can queue them for a fresh turn the agent will
   * actually hear.
   */
  "run:inject_failed": { projectId: string; messageId: string; body: string };
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
  "run:usage": {
    projectId: string;
    tokens: number;
    /**
     * How full the window is right now — the one figure here that is exact
     * mid-turn rather than an understatement.
     *
     * Null from an agent that does not report it. The header otherwise learns
     * this only from a finished turn's stored row, so it stood still for the
     * length of a run and moved in a single jump at the end.
     */
    contextTokens: number | null;
    contextWindow: number | null;
  };
  /**
   * What this agent can do, from its own catalogue at run start.
   *
   * `all` includes `skills`; the rest are the CLI's built-in utilities. Read
   * from the agent rather than compiled in, since plugins and installed skills
   * make the set per-machine. Arrives once per run, so a session that has not
   * run yet has none and the composer falls back to what it knows itself.
   */
  "run:commands": { projectId: string; agent: Agent; all: string[]; skills: string[] };
  /**
   * A conversation being rewritten into a summary of itself.
   *
   * `driver` says whose turn it is happening inside, and the window treats the
   * two very differently. `command` is a `/compact` this app asked for: it owns
   * the run, holds the composer, and the status line is its own. `agent` is the
   * CLI compacting on its own as the window fills, mid-answer — weather during
   * someone else's run, which must not touch that run's status line.
   *
   * `learning` is the pass that runs *before* the summary, asking the
   * conversation what must outlive it — see `notes.rs`. It is a separate phase
   * because it is the slow half and the user is watching a frozen composer:
   * "compacting" while the agent is actually taking notes reads as a hang.
   *
   * `ok` and `error` are absent until `finished`: nothing has been decided yet.
   */
  "run:compaction": {
    projectId: string;
    agent: Agent;
    driver: "command" | "agent";
    phase: "learning" | "started" | "finished";
    ok?: boolean;
    error?: string | null;
  };
  "run:rate_limit": RateLimit;
  /**
   * The limit has lifted. Without this the header pill and the tab dot stay
   * blocked for the rest of the session, since `resetsAt` passing is not
   * something the window can observe on its own.
   */
  "run:rate_limit_cleared": { projectId: string; agent: Agent };
  /**
   * A tool call is waiting on the user. The run is blocked mid-turn until
   * `resolveApproval` answers, so this must render somewhere it will be seen.
   */
  "run:approval": { projectId: string } & PendingApproval;
  /** The question above was answered (by the user, or denied on timeout). */
  "run:approval_resolved": { projectId: string; approvalId: string; allow: boolean };
  "run:stopped": {
    projectId: string;
    agent: Agent;
    model: string;
    permission: Permission;
    stop: string;
    exitCode: number | null;
  };
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
