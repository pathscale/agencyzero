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

/**
 * The dot on a project tab.
 *
 * - `running` — the agent is working: thinking, replying, or running a tool.
 * - `blocked` — it needs you: a moderation hold, or a live rate limit.
 * - `error`   — a critical hold, which cancelled the run.
 * - `ready`   — active and idle, waiting for input.
 * - `quiet`   — inactive: a project that is finished, cancelled or not started.
 *
 * `ready` and `quiet` used to be one state, which meant a project waiting for
 * you looked identical to one you had closed out.
 */
export type TabStatus = "running" | "blocked" | "error" | "ready" | "quiet";

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
  /**
   * The agent's own session id, from `Event::Started`. Null until the first run
   * reveals one — this is the handle a later turn resumes with, so it belongs to
   * the project rather than to any one message.
   */
  sessionId: string | null;
  /** ISO 8601. Orders the Recent list. */
  lastActivityAt: string;
}

/**
 * One line of the raw exchange with the agent, for the I/O panel.
 *
 * `direction` is from the app's point of view: `sent` is what went to the agent,
 * `received` is what came back. This is the crate's event stream rather than the
 * process's literal stdout — `agent-abstraction` parses stdout into events and
 * does not hand back the raw lines, so `unparsed` is how a line it could not
 * read is surfaced.
 */
export interface AgentIoEntry {
  id: string;
  projectId: string;
  /** ISO 8601. */
  at: string;
  direction: "sent" | "received";
  /** `request` · `started` · `text` · `thinking` · `tool_call` · `tool_result` · `rate_limit` · `stop` · `stderr` · `unparsed` */
  kind: string;
  detail: string;
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
  /** Input plus output for this turn: the new work it did. */
  tokens: number;
  /**
   * Every input token the turn was charged for, cached or not — the size of the
   * conversation as the model saw it.
   *
   * **Already cumulative, so it must not be summed across turns.** The agent
   * re-sends the whole conversation each turn and reports it, mostly as cache
   * reads; adding it up counts the same conversation once per turn and the error
   * grows with the session. `agent-abstraction` ships `Usage::accumulate` for
   * exactly this reason, and `usageTotals` follows the same rule.
   */
  contextTokens: number | null;
  /** The model's context window. Claude alone reports one. */
  contextWindow: number | null;
  /** Cumulative like `contextTokens`, not additive. */
  cacheReads: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  /** Copilot reports premium requests instead of a dollar cost. */
  premiumRequests: number | null;
  durationMs: number | null;
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

/**
 * Where the WorkTable data directory is, and whether the UI may change it.
 *
 * Not part of `GlobalSettings` on purpose: settings are a row in the database,
 * so the database's own location cannot be one of them. It resolves from an
 * environment variable or a pointer file before anything opens.
 */
export interface WorkspaceRoot {
  path: string;
  exists: boolean;
  /** True when this is the resolved recommendation, not a stored choice. */
  isDefault: boolean;
}

export interface DataLocation {
  path: string;
  /** `default` | `pointer` | `env`. */
  source: "default" | "pointer" | "env";
  /** False when `AZ_DATA_DIR` set it, which a pointer file cannot override. */
  isEditable: boolean;
}

/** Whether an id names one model or points at whichever is current. */
export type ModelKind = "alias" | "pinned";

/**
 * How the crate established a catalogue, weakest evidence wins.
 *
 * `cli` means the CLI itself was asked and can be asked again. `picker` was read
 * out of an interactive picker and ages silently. `docs` came from vendor
 * documentation and says nothing about the installed binary.
 */
export type ModelSource = "cli" | "picker" | "docs";

/** One model a caller can choose. Mirrors `agent_abstraction::Model`. */
export interface Model {
  /** Exactly what goes to `--model`, passed through verbatim. */
  id: string;
  /** The vendor's own display name. */
  name: string;
  /** One line on what it is for. Empty when the vendor offers none. */
  note: string;
  kind: ModelKind;
  /** Reasoning levels this model accepts, in the vendor's order. Often empty. */
  efforts: string[];
  /** What the agent falls back to when no model is named. */
  isDefault: boolean;
}

/**
 * One agent's catalogue.
 *
 * Advisory, and never an entitlement: what an agent offers and what an account
 * may use are different sets, and only the account knows the second. A model the
 * plan does not cover fails at run time with the provider's own wording, which is
 * a better error than a picker that quietly hides it.
 */
export interface AgentModels {
  agent: Agent;
  models: Model[];
  source: ModelSource;
  /** ISO date the catalogue was last checked. */
  checked: string;
  /** The CLI release it was checked against. */
  against: string;
  /** True when the CLI was asked just now, false when the compiled list was used. */
  discovered: boolean;
}

/**
 * Which models the user wants offered for one agent, and which is preselected.
 *
 * Catalogues are long and account-specific, so the picker shows what was chosen
 * here rather than everything the vendor lists. Two invariants hold, both
 * enforced in the store: `default` is always a member of `enabled`, and `enabled`
 * is never emptied. Together they mean a picker can never end up with nothing in
 * it.
 */
export interface ModelSelection {
  enabled: string[];
  default: string;
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
  /**
   * Where a new project runs. Empty means not chosen, which resolves to
   * `$HOME/AgencyZero` at read time rather than being frozen into the record.
   */
  workspaceRoot: string;
  /**
   * Per agent, which models the picker offers and which one it starts on.
   *
   * This replaces the design's single `defaultModel`, which could not express a
   * per-agent choice. The prompt reads the `claude` entry; `codex` and `copilot`
   * are collected now and consumed by the code review UI later.
   */
  models: Record<Agent, ModelSelection>;
  defaultPermission: Permission;
  /** Reasoning level a new tab starts on. */
  defaultEffort: string;
  moderator: ModeratorSettings;
  /**
   * How the Home task manager runs. Its own model and effort, deliberately
   * not the prompt's: a list keeper running unattended wants a cheap fast
   * model far more often than a frontier one.
   */
  taskManager: TaskManagerSettings;
  envPolicy: EnvPolicy;
  /** Off by default: HTTPS_PROXY often embeds credentials. */
  forwardProxyVars: boolean;
  notifications: NotificationSettings;
}

/** Mirrors `settings::TaskManager`. Claude only for now; see the Rust doc. */
export interface TaskManagerSettings {
  model: string;
  effort: string;
}

/**
 * Where the Home task manager's conversation stands.
 *
 * Its own DTO because the task manager has no project row: the session id the
 * ordinary path hangs off `Project` has nowhere else to travel.
 */
export interface TaskManagerState {
  sessionId: string | null;
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
  /**
   * The tab's reasoning effort, empty when the model's catalogue entry does not
   * establish a ladder. Empty is "not established", not "no effort setting".
   */
  effort: string;
  /** The tab's posture for the whole session. Lives only in the composer pill. */
  permission: Permission;
  status: TabStatus;
}

/** GUI-local, outside Project and ProjectItem scope. */
export interface UiPrefs {
  lastModel: string;
  lastPermission: Permission;
  /** Which accordion sections are expanded — per install, not per project. */
  panelSections: {
    /** The Claude quota lines at the top of the project column. */
    usage: boolean;
    settings: boolean;
    items: boolean;
    running: boolean;
    log: boolean;
    /** The raw agent exchange. Closed by default — it is a diagnostic. */
    io: boolean;
  };
  lastTabKey: string;
  taskPlacement: TaskPlacement;
  /**
   * Panel sections whose shipped default has already been applied once.
   *
   * Stored prefs beat defaults, which is wrong for a section that shipped
   * closed, was never seen, and has since been changed to open. This records
   * that the one-time reset has happened, so the user's own choice sticks after
   * it. See `RESET_ONCE` in `stores/prefs.ts`.
   */
  seenSections: string[];
}

/**
 * One quota window, in the provider's own terms.
 *
 * Mirrors `agent_abstraction::UsageWindow`. `usedFraction` is 0..1 and is null
 * when the provider reported no proportion — never synthesised, because a bar
 * drawn from a guess is a number someone would plan around.
 */
export interface QuotaWindow {
  /** The provider's own name for it, e.g. `primary`. */
  window: string;
  usedFraction: number | null;
  /** How long the window runs. Codex reports 10080 for a week. */
  windowMinutes: number | null;
  /** ISO 8601. */
  resetsAt: string | null;
}

/**
 * What one agent reports about the account behind it.
 *
 * `supported: false` and an empty `windows` is "this agent cannot tell us",
 * which is different from `supported: true` and an empty `windows`, meaning "no
 * windows are in force". Only Codex answers today; Claude reports quota solely
 * during a run, as a rate limit.
 */
export interface AgentQuota {
  agent: Agent;
  supported: boolean;
  windows: QuotaWindow[];
  plan: string | null;
  /** As the provider wrote it. Text, so a decimal balance is not rounded. */
  creditBalance: string | null;
  unlimited: boolean;
  /** Why there is nothing to show. Rendered as-is. */
  detail: string;
}

export interface QuotaReport {
  agents: AgentQuota[];
  /** ISO 8601, so a stale answer is visibly stale. */
  checkedAt: string;
}

/** `Event::RateLimit` — the crate reports rather than retries. */
export interface RateLimit {
  projectId: string;
  /**
   * Whether anything was actually refused.
   *
   * `agent-abstraction` emits a rate-limit record on runs that were **not**
   * limited — status `allowed` is a heartbeat saying "still fine". Treating
   * every record as a limit is what put an orange "allowed (five_hour)" warning
   * in the header of a healthy run and turned its tab dot amber.
   */
  isBlocking: boolean;
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
