import type {
  AgentStatus,
  CreatedProject,
  GlobalSettings,
  Message,
  Permission,
  Project,
  ProjectItem,
  ProjectStatus,
  RateLimit,
  RunningTask,
  TaskLogEntry,
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
  }): Promise<CreatedProject>;
  deleteProject(id: string): Promise<void>;
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
  reorderItems(projectId: string, ids: string[]): Promise<ProjectItem[]>;

  // — Conversation ————————————————————————————————————————————
  listMessages(projectId: string): Promise<Message[]>;
  sendMessage(input: {
    projectId: string;
    body: string;
    itemId?: string | null;
    model?: string;
    permission?: Permission;
  }): Promise<Message>;
  /** Approve once / Deny on a moderator hold. */
  resolveModeration(messageId: string, approve: boolean): Promise<Message>;

  // — Settings ————————————————————————————————————————————————
  getSettings(): Promise<GlobalSettings>;
  setSettings(patch: DeepPartial<GlobalSettings>): Promise<GlobalSettings>;
  /** Probes the installed CLIs. `recheck` forces a fresh probe. */
  listAgentStatus(recheck: boolean): Promise<AgentStatus[]>;

  // — Runs and tasks ——————————————————————————————————————————
  /** The tab's model and posture stick until changed again. */
  setTabModel(tabKey: string, model: string, permission: Permission): Promise<void>;
  /** `Run::cancel` — resolves once the process group is gone. */
  cancelRun(projectId: string): Promise<void>;
  listRunningTasks(projectId: string): Promise<RunningTask[]>;
  cancelTask(toolCallId: string): Promise<void>;
  /**
   * Paginated, newest first. `total` is the whole log, not the page — the
   * panel badge reads "91" while holding six rows, so the count has to come
   * back with the page rather than be inferred from it.
   */
  listTaskLog(projectId: string, limit: number, before?: string): Promise<TaskLogPage>;
  clearTaskLog(projectId: string): Promise<void>;
  /**
   * Rate limits currently in force.
   *
   * `run:rate_limit` announces a *change*; a window opened after one arrived
   * would otherwise show a clear header for a tab that is still blocked. Not
   * in the design's proposed surface — see the frontend README.
   */
  listRateLimits(): Promise<RateLimit[]>;

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
  /** author: user | agent | moderator. */
  "message:appended": Message;
  /** The tab dot goes blocked until this one is resolved. */
  "moderation:blocked": Message;
  /** `Event::ToolCall`. */
  "task:started": RunningTask;
  "task:progress": RunningTask;
  /** `Event::ToolResult` — the row leaves Running and lands in the log. */
  "task:finished": TaskLogEntry;
  "run:rate_limit": RateLimit;
  /**
   * The limit has lifted. Without this the header pill and the tab dot stay
   * blocked for the rest of the session, since `resetsAt` passing is not
   * something the window can observe on its own.
   */
  "run:rate_limit_cleared": { projectId: string };
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
