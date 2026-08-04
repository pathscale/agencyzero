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
/**
 * The life of a row, in order.
 *
 * - `new` is proposed and untriaged. Nobody has decided anything about it.
 * - `pending` is accepted and queued.
 * - `planning` is the phase before work, where the shape is still being argued
 *   about. A list that jumped from proposed to in-progress could not show it.
 * - `active` is being worked on.
 * - `shipped` names a pull request and waits for the owner. An agent can say it
 *   shipped something; it cannot say the thing works, because it is not the one
 *   looking at the screen. Without this state a fix reported as done was
 *   indistinguishable from one that worked, and a copy bug was reported fixed
 *   three times in one evening.
 * - `questions` is started and stopped on something only the owner can answer.
 *   Distinct from `active`, which claims work is happening, and from `new`,
 *   which claims nobody has looked yet. A row waiting on a person used to read
 *   as one of those two, so a list could not say which of its items were
 *   waiting on the person reading it.
 * - `finished` is the owner's word, never the agent's.
 */
export type ProjectStatus =
  | "new"
  | "pending"
  | "planning"
  | "active"
  | "questions"
  | "shipped"
  | "finished"
  | "canceled";

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

/** `Agent` in the crate. Settings covers all three; project tabs expose Claude and Codex. */
export type Agent = "claude" | "codex" | "copilot";

/** `Permission` in the crate. `read_only` is the default and widens deliberately. */
export type Permission = "read_only" | "plan" | "ask" | "edit" | "auto" | "bypass";

/**
 * A tool call the agent is waiting for permission to make.
 *
 * `input` is the arguments exactly as the agent sent them — **show it**: for
 * Bash the command lives there, and approving on the tool name alone approves
 * an unseen command. The run is blocked mid-turn until this is answered.
 */
export interface PendingApproval {
  approvalId: string;
  tool: string;
  input: unknown;
}

/**
 * Who is speaking in the transcript.
 *
 * `system` is the app's own voice — something that happened *to* the
 * conversation rather than in it, like a compaction rewriting everything above
 * it. Distinct from `moderator`, which is the supervision feature and carries a
 * verdict; a compaction filed as a moderator note rendered as an empty amber
 * card, because the card is built out of a verdict it did not have.
 */
export type MessageAuthor = "user" | "agent" | "moderator" | "system";

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
  /** Native session ids kept separately so changing providers can resume either conversation. */
  sessions: Partial<Record<Agent, string>>;
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
  /** A legacy PR number, or `issue:<canonical GitHub URL>`. */
  reference: string | null;
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
  /** Everything this turn processed: input, output and both cache figures. */
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
  /** Structured facts used to decide which controls are safe to offer. */
  capabilities: ProviderCapabilities;
  /** ISO 8601. Drives "last checked 2 min ago". */
  checkedAt: string;
}

export interface ProviderCapabilities {
  session: boolean;
  fork: boolean;
  events: boolean;
  nativeSystem: boolean;
  commands: boolean;
  liveFollowUp: boolean;
  approvals: boolean;
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
  source: "default" | "pointer" | "env" | "ephemeral";
  /** False when `AZ_DATA_DIR` set it, which a pointer file cannot override. */
  isEditable: boolean;
}

/**
 * Where this session opened, and where the next launch will.
 *
 * The two diverge as soon as the location is changed: the pointer takes effect
 * on the next launch and nothing is moved in between. Settings shows both,
 * because the session's path alone makes a change that was written look exactly
 * like a change that did nothing.
 */
/** One table's footprint on disk. Mirrors `main.rs`'s `TableSize`. */
export interface TableSize {
  /** The table's directory name, e.g. `task_log`. */
  name: string;
  bytes: number;
}

export interface DataLocationView extends DataLocation {
  /** The next launch's location, or `null` while it agrees with this one. */
  pending: DataLocation | null;
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

/** Explicit local consent and backend-owned interval for the PS study. */
export interface StudyAnalyticsSettings {
  enabled: boolean;
  sessionId: string;
  enabledAt: string;
}

/** Content-free study status shown in Settings. */
export interface StudySummary {
  enabled: boolean;
  studyId: string | null;
  enabledAt: string | null;
  eventCount: number;
  firstAt: string | null;
  lastAt: string | null;
}

/** Content-free composer facts captured before controls and paths are compiled. */
export interface StudyTurnMetadata {
  authoredCharacterCount: number;
  authoredLineCount: number;
  attachmentCount: number;
  userAuthoredPs: boolean;
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
  /**
   * What the owner's finished action does to an existing item: `"resolve"`
   * keeps the finished row, while `"delete"` removes it outright.
   */
  completedItems: "resolve" | "delete";
  /** How the workspace is coloured. See {@link ThemeSettings}. */
  theme: ThemeSettings;
  /** Off by default; events stay local until an explicit export. */
  studyAnalytics: StudyAnalyticsSettings;
  /**
   * Inject the AgencyZero + Prompt Syntax operating instructions into every
   * turn. On by default: the app's items, questions, and PR tracking only work
   * if the agent is told the surface. A user file `AgencyZeroPerTurn.md` in the
   * config directory overrides the built-in text.
   */
  perTurnInjection: boolean;
}

/**
 * Mirrors `settings::Theme` — the two axes the picker drives.
 *
 * In settings rather than `localStorage` because that is where this app keeps
 * state: a webview store would not survive a data directory move and would not
 * appear in an export.
 */
export interface ThemeSettings {
  /**
   * Accent as `#rrggbb`. Empty means the palette's own yellow — deliberately
   * not the literal, so the record cannot drift from the stylesheet.
   */
  accent: string;
  /**
   * Lightness added to every surface in oklch points, and taken off every text
   * rung. One number: lifting the desk without bringing the text down trades
   * one glare for another. 0 is the palette as designed.
   */
  softness: number;
  /**
   * How much of the accent is mixed into every surface, as a percentage. The
   * difference between a pick that changes buttons and one that changes the
   * workspace. Ignored while `accent` is empty.
   */
  wash: number;
  /**
   * Lightness added back to every text rung, in oklch points. Softness dims the
   * text as it lifts the surfaces; this is the counterweight, so "less glare"
   * and "less faded" stop being one number. Negative dims further.
   */
  textBrightness: number;
}

/** Mirrors `settings::TaskManager`. */
export interface TaskManagerSettings {
  agent: Agent;
  model: string;
  effort: string;
  permission: Permission;
  /**
   * Where its runs execute, first entry as the working directory. Empty means
   * the workspace root — which, under read_only's deny-outside-the-tree
   * posture, is the only place the task manager can then read.
   */
  dirs: string[];
}

/**
 * Spend over the ranges Settings displays, summed from the usage ledger.
 *
 * Every figure is priced by the agent itself, per turn, at API list rates —
 * on a subscription plan this measures consumption, not a bill. `turns` is
 * the number of priced turns behind `totalUsd`.
 */
export interface CostSummary {
  todayUsd: number;
  weekUsd: number;
  monthUsd: number;
  totalUsd: number;
  turns: number;
}

/**
 * Exactly which build the running process is.
 *
 * The version names every build for weeks, so it cannot distinguish a fresh
 * bundle from a stale one; the commit and compile time can. A `*` after the
 * sha means the tree had uncommitted edits when the build ran.
 */
export interface BuildInfo {
  version: string;
  gitSha: string;
  builtAt: string;
}

/** A newer published version than the one running, from the update manifest. */
export interface AvailableUpdate {
  version: string;
  notes: string | null;
  date: string | null;
}

/**
 * Where the Home task manager's conversation stands.
 *
 * Its own DTO because the task manager has no project row: the session id the
 * ordinary path hangs off `Project` has nowhere else to travel.
 */
export interface TaskManagerState {
  agent: Agent;
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
  /** Which CLI receives this tab's prompts. */
  agent: Agent;
  /** The tab's model. Swapping it in the composer sticks until changed again. */
  model: string;
  /**
   * The tab's reasoning effort, empty when the model's catalogue entry does not
   * establish a ladder. Empty is "not established", not "no effort setting".
   */
  effort: string;
  /**
   * Whether the model may spend reasoning tokens ("Extra Thinking"). On by
   * default; only meaningful for Claude, where off sends `thinking(false)`. Off
   * is a no-op for the other agents. Per tab, like the model and effort pills.
   */
  extraThinking: boolean;
  /** The tab's posture for the whole session. Lives only in the composer pill. */
  permission: Permission;
  status: TabStatus;
}

/** GUI-local, outside Project and ProjectItem scope. */
export interface UiPrefs {
  lastModel: string;
  lastPermission: Permission;
  /** Local interface scale. Large is the designed default for this desktop UI. */
  uiSize: "normal" | "large" | "extra-large";
  /** Local palette mode. Independent of the persisted accent axes. */
  colorMode: "dark" | "light";
  /**
   * The last "Extra Thinking" choice, so a new tab starts where the last one
   * was left. On by default, like the composer control it seeds.
   */
  lastExtraThinking: boolean;
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
    /** What the agent kept across a compaction. Closed until there is any. */
    notes: boolean;
    /** Home's right column. */
    pinned: boolean;
    recent: boolean;
    homeIo: boolean;
    /**
     * The task manager's reply and collected list on Home. Off by default:
     * these are debug surfaces for when a harvest goes wrong, not reading
     * material — the approval card stays visible regardless, since a blocked
     * run cannot wait behind a toggle.
     */
    tmDebug: boolean;
  };
  lastTabKey: string;
  /**
   * The project tabs that were open, restored on launch. Boot used to open a
   * tab per project, which meant a restart un-did every close.
   */
  openTabKeys: string[];
  /** Home project groups folded to their header, by project id. */
  collapsedGroups: string[];
  /** Project item lists the user expanded past their compact height. */
  expandedItemProjects: string[];
  /** Composer drafts currently using the Prompt Syntax aware editor. */
  advancedComposerKeys: string[];
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
  /**
   * Half-written messages, by project id.
   *
   * Switching tabs unmounts the project screen — `App.tsx` renders one `Match`
   * at a time — so a composer's local state dies with it and an unsent reply
   * was simply gone on return. Persisted rather than merely hoisted, because
   * the same reasoning applies to closing the window: text someone typed is
   * theirs, and losing it is never the smaller surprise.
   */
  composerDrafts: Record<string, string>;
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

export interface ClaudeUsageWindow {
  /** Provider percentage in the range 0..100. */
  utilization: number;
  /** ISO 8601. */
  resetsAt: string | null;
}

export interface ClaudeUsageLimit {
  kind: string;
  /** Provider percentage in the range 0..100. */
  percent: number;
  severity: string | null;
  /** ISO 8601. */
  resetsAt: string | null;
  model: string | null;
}

/** Experimental subscription usage fetched through Claude Code's managed login. */
export interface ClaudeUsage {
  fiveHour: ClaudeUsageWindow | null;
  sevenDay: ClaudeUsageWindow | null;
  sevenDaySonnet: ClaudeUsageWindow | null;
  limits: ClaudeUsageLimit[];
  /** ISO 8601, so a stale answer is visibly stale. */
  checkedAt: string;
}

/** `Event::RateLimit` — the crate reports rather than retries. */
export interface RateLimit {
  projectId: string;
  /** The provider account whose window this describes. */
  agent: Agent;
  /**
   * Whether anything was actually refused.
   *
   * `agent-abstraction` emits a rate-limit record on runs that were **not**
   * limited — status `allowed` is a heartbeat saying "still fine". Treating
   * every record as a limit is what put an orange "allowed (five_hour)" warning
   * in the header of a healthy run and turned its tab dot amber.
   */
  isBlocking: boolean;
  /**
   * Nothing was refused, but the provider is flagging the window.
   *
   * The state that had nowhere to go: emitted, dropped by the header for not
   * being blocking, and never shown to anyone. A warning is exactly the point
   * at which a person, or an agent, can still do something about it.
   */
  isWarning: boolean;
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

/**
 * A pull request cut during a run, tracked as a chip over the composer.
 * `state` is GitHub's own word (OPEN | MERGED | CLOSED, or "unknown" before
 * gh first answers); `ci` is the check rollup reduced to one word.
 */
export interface PullRequest {
  id: string;
  projectId: string;
  url: string;
  repo: string;
  number: number;
  branch: string;
  state: string;
  additions: number;
  deletions: number;
  ci: "pass" | "fail" | "pending" | "none" | "unknown";
  dismissed: boolean;
}

/** A question an agent raised for the owner, a chip beside the PR chips. */
export interface Question {
  id: string;
  projectId: string;
  text: string;
  /** How loudly it calls: answer now, blocked until answered, or when free. */
  urgency: "critical" | "blocking" | "passive";
  /** The item it is about, when one was named. */
  itemId?: string;
  /** The GitHub issue it is about, when one was named. */
  issueUrl?: string;
  answered: boolean;
  createdAt: string;
}
