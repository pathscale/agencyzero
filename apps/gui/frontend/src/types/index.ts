/**
 * The shapes the workspace UI reads, transcribed from `design/data-model.html`.
 *
 * These are the frontend's view of the model — what a Tauri command returns
 * once serde has been through it. Field names are the agreed proposal for
 * `az-core`; names that come from the `agent-abstraction` crate are its
 * vocabulary, not ours, and are called out where they appear.
 */

/** Which screen a tab shows. `home` is not closable; the rest are. */
export type TabKind = "home" | "draft" | "settings" | "project";

/** One enum for both layers: a Project and its ProjectItems share it. */
export type ProjectStatus = "pending" | "active" | "finished" | "canceled";

/** The dot on a project tab. */
export type TabStatus = "running" | "blocked" | "error" | "quiet";

/** `Agent` in the crate. Claude in practice today. */
export type Agent = "claude" | "codex" | "copilot";

/** `Permission` in the crate. `read_only` is the default and widens deliberately. */
export type Permission = "read_only" | "plan" | "edit" | "auto" | "bypass";

/** Who is speaking in the transcript. */
export type MessageAuthor = "user" | "agent" | "moderator";

/** `Stop` in the crate; anything other than these two arrives as a bare string. */
export type StopReason = "completed" | "error" | (string & {});

/** How a moderator note landed. */
export type ModerationVerdict = "noted" | "blocked" | "flagged";

/**
 * How hard a hold bites. `check` parks that one step and lets the rest run;
 * `critical` cancels the run and its whole process group.
 */
export type ModerationSeverity = "check" | "critical";

/** Probe result for an installed agent CLI. */
export type AgentState = "connected" | "outdated" | "logged_out" | "missing";

/** `EnvPolicy` in the crate. `minimal` passes only PATH, HOME and USER. */
export type EnvPolicy = "minimal" | "inherit";

/** What a `check`-severity hold does. */
export type OnCheck = "hold_step" | "notify";

/** What a `critical`-severity hold does. */
export type OnCritical = "cancel_run" | "hold_step";

/** Where the Running / Task log sections render. Only `panel` is built. */
export type TaskPlacement = "panel" | "dock" | "inline";

/**
 * Layer 1 of the Home list. One open tab per project, and it carries its own
 * status. A fork is a new session, so it is a new Project that shares history
 * up to `forkedFrom.messageId`.
 */
export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  order: number;
  /** Working directories, added in the project's Settings section — not asked for at init. */
  dirs: string[];
  pinned: boolean;
  /** Per-session override of `GlobalSettings.moderator.enabled`. */
  moderatorEnabled: boolean;
  forkedFrom: { projectId: string; messageId: string } | null;
  /** ISO 8601. Orders the Recent list. */
  lastActivityAt: string;
}

/** Layer 2 — the work items inside a Project. Same status enum as its parent. */
export interface ProjectItem {
  id: string;
  projectId: string;
  /** One short line, not a body. Wraps to two lines at 12.5px. */
  title: string;
  status: ProjectStatus;
  order: number;
}

/**
 * The Untitled tab: an empty chat and nothing else. The first message creates
 * the project; the name and the initial items come back from the reply.
 */
export interface ProjectDraft {
  draftId: string;
  /** Inferred by the agent from the first message; until then the tab reads "Untitled". */
  name: string | null;
  status: ProjectStatus;
  firstMessage: string;
  error: string | null;
}

/** From `Outcome::usage`. Absent means "the agent did not say", never zero. */
export interface Usage {
  tokens: number;
  cacheReads: number | null;
  costUsd: number | null;
  /** Copilot reports premium requests instead of a dollar cost. */
  premiumRequests: number | null;
}

/**
 * The supervising voice: a second agent reading both the transcript and the raw
 * event stream. It reacts after a call starts, so its job is containment, not
 * prevention.
 */
export interface Moderation {
  verdict: ModerationVerdict;
  severity: ModerationSeverity | null;
  /** Which `ToolCall` it judged; null for a periodic summary. */
  toolCallId: string | null;
  reason: string;
  /** True → Approve once / Deny appear and the run holds. */
  needsApproval: boolean;
  /** Which rule fired, for the audit trail. */
  policy: string | null;
}

/**
 * One transcript per project tab. Agent, model, permission and usage are
 * recorded per message so history stays readable after the tab's settings move
 * on.
 */
export interface Message {
  id: string;
  projectId: string;
  /** Soft association to a ProjectItem — never enforced; null is normal. */
  itemId: string | null;
  author: MessageAuthor;
  agent: Agent;
  /** Set when `author` is "moderator". */
  moderation: Moderation | null;
  /** `Request::model` — the tab's model at send time. */
  model: string;
  permission: Permission;
  usage: Usage | null;
  stop: StopReason;
  exitCode: number | null;
  /** Markdown, as the agent emits it. */
  body: string;
  /** ISO 8601. Transcript order. */
  createdAt: string;
}

/** Live now — one per `Event::ToolCall` with no result yet. */
export interface RunningTask {
  /** The crate's `ToolCall::id`; null when the agent does not give one. */
  toolCallId: string | null;
  projectId: string;
  itemId: string | null;
  /** `ToolCall::name` — "Bash", "Edit", "command_execution" … */
  name: string;
  /** The row's label, rendered from `ToolCall::input`. */
  label: string;
  /** ISO 8601. Drives the elapsed counter. */
  startedAt: string;
  /** Always true: dropping the Run kills the agent and its whole process group. */
  isCancelable: boolean;
}

/** History — what ran, newest first. A finished RunningTask becomes one of these. */
export interface TaskLogEntry {
  id: string;
  /**
   * The `RunningTask` this closes out — `ToolCall::id`, carried through so a
   * result can be matched to its call by identity.
   *
   * Labels are not identities: two shell commands, two reads of the same file
   * or two calls to the same MCP tool share one. Null when the agent gave no
   * id, in which case the row cannot be correlated and is only history.
   */
  toolCallId: string | null;
  projectId: string;
  itemId: string | null;
  label: string;
  /** Same vocabulary as `RunningTask.name`. */
  tool: string;
  /** `ToolResult::ok` — null when the agent does not say, which is not failure. */
  ok: boolean | null;
  /** `ToolResult::output`, capped at MAX_CAPTURE (1 MiB). */
  output: string;
  durationMs: number | null;
  /** Set instead of a duration when the tool exited non-zero. */
  exitCode: number | null;
  /** ISO 8601. Sort key. */
  finishedAt: string;
}

/** One per agent, detected by probing the installed CLI — never configured. */
export interface AgentStatus {
  agent: Agent;
  state: AgentState;
  /** As the CLI reports it, e.g. "2.1.205". */
  version: string | null;
  /** What this build was verified against; an older CLI reads as "outdated". */
  minVersion: string;
  /** From the crate: fork (Claude only), caller-minted session id, agent-printed thread id. */
  caps: string[];
  /** ISO 8601. Drives "last checked 2 min ago". */
  checkedAt: string;
}

export interface ModeratorSettings {
  enabled: boolean;
  /** The watcher runs as its own agent — a cheap model is the point. */
  model: string;
  /** Both: the chat as you see it, plus ToolCall inputs and ToolResult outputs. */
  sees: ("transcript" | "events")[];
  onCheck: OnCheck;
  onCritical: OnCritical;
  confineToDirs: boolean;
}

export interface NotificationSettings {
  onHold: boolean;
  onRunFinished: boolean;
  onTaskFailed: boolean;
  onRateLimited: boolean;
  sound: boolean;
}

/** One record, persisted. Every new tab starts from it. */
export interface GlobalSettings {
  defaultAgent: Agent;
  defaultModel: string;
  defaultPermission: Permission;
  moderator: ModeratorSettings;
  envPolicy: EnvPolicy;
  /** Off by default: HTTPS_PROXY often embeds credentials. */
  forwardProxyVars: boolean;
  notifications: NotificationSettings;
}

/** Window chrome state. Every open tab maps back to a Project and its items. */
export interface Tab {
  /** "home" | draftId | projectId. */
  key: string;
  kind: TabKind;
  /** → `Project.id`; null only for home and an uncreated draft. */
  projectId: string | null;
  label: string;
  /** The tab's model. Swapping it in the composer sticks until changed again. */
  model: string;
  /** The tab's posture for the whole session. Lives only in the composer pill. */
  permission: Permission;
  status: TabStatus;
}

/** GUI-local, outside Project and ProjectItem scope. */
export interface UiPrefs {
  lastModel: string;
  lastPermission: Permission;
  /** Which accordion sections are expanded — per install, not per project. */
  panelSections: { settings: boolean; items: boolean; running: boolean; log: boolean };
  lastTabKey: string;
  taskPlacement: TaskPlacement;
}

/** `Event::RateLimit` — the crate reports rather than retries. */
export interface RateLimit {
  projectId: string;
  /** The provider's own wording. */
  message: string;
  /** ISO 8601, or null when the provider does not say. */
  resetsAt: string | null;
}

/** What `create_project` hands back once the first reply lands. */
export interface CreatedProject {
  project: Project;
  items: ProjectItem[];
}
