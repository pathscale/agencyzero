import type {
  Agent,
  AgentModels,
  AgentStatus,
  GlobalSettings,
  Message,
  Model,
  Project,
  ProjectItem,
  PullRequest,
  Question,
  RunningTask,
  TaskLogEntry,
} from "~/types";

/**
 * The mockup's own data, transcribed from `design/workspace.html`.
 *
 * This is what the mock backend serves, so the running app matches the
 * handover PNGs screen for screen — which is what makes a design review of the
 * real app possible before any of it is wired to Rust.
 *
 * Timestamps are relative to load: the elapsed counters have to tick, and a
 * frozen "0:41" would read as a broken clock rather than a running task.
 */

const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();

/*
 * Codex is the one agent that varies its effort ladder by model, so the levels
 * are named once here rather than repeated per entry. Kept as plain strings for
 * the reason the crate gives: `ultra` arrived on some models and not others, and
 * an enum would need editing before a new level could even be named.
 */
const FULL = ["low", "medium", "high", "xhigh", "max", "ultra"];
const TO_MAX = ["low", "medium", "high", "xhigh", "max"];
const TO_XHIGH = ["low", "medium", "high", "xhigh"];

// The ladder claude 2.1.212 accepts on --effort, mirrored from the crate's
// catalogue so the preview's effort pill behaves like the real one.
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const alias = (id: string, name: string, note: string, isDefault = false): Model => ({
  id,
  name,
  note,
  kind: "alias",
  efforts: CLAUDE_EFFORTS,
  isDefault,
});

const pinned = (
  id: string,
  name: string,
  note: string,
  efforts: string[] = [],
  isDefault = false,
): Model => ({ id, name, note, kind: "pinned", efforts, isDefault });

export const PROJECTS: Project[] = [
  {
    id: "worktable",
    name: "WorkTable",
    status: "active",
    order: 0,
    dirs: ["~/src/WorkTable", "~/src/api.support.cafe"],
    pinned: true,
    moderatorEnabled: true,
    forkedFrom: null,
    sessionId: null,
    sessions: {},
    lastActivityAt: ago(2 * 60_000),
  },
  {
    id: "cafe",
    name: "api.support.cafe",
    status: "pending",
    order: 1,
    dirs: ["~/src/api.support.cafe"],
    pinned: false,
    moderatorEnabled: true,
    forkedFrom: null,
    sessionId: null,
    sessions: {},
    lastActivityAt: ago(9 * 60_000),
  },
  {
    id: "agencyzero",
    name: "agencyzero",
    status: "pending",
    order: 2,
    dirs: ["~/src/agencyzero"],
    pinned: true,
    moderatorEnabled: true,
    forkedFrom: null,
    sessionId: null,
    sessions: {},
    lastActivityAt: ago(26 * 60 * 60_000),
  },
];

const item = (
  projectId: string,
  order: number,
  title: string,
  status: ProjectItem["status"],
): ProjectItem => ({
  id: `${projectId}-${order}`,
  projectId,
  title,
  status,
  order,
  reference: null,
});

export const ITEMS: ProjectItem[] = [
  item("worktable", 0, "Phase A — safety quick-wins → 0.9.3", "active"),
  item("worktable", 1, "Phase B — engine observability (API break)", "pending"),
  item("worktable", 2, "Phase C — benches before the rewrite", "pending"),
  item("worktable", 3, "Reader-model design proposal", "pending"),
  item("worktable", 4, "Ship corrective 0.9.2 release", "finished"),

  item("cafe", 0, "Legacy-data scan on prod snapshot", "active"),
  item("cafe", 1, "endpoint-libs 2.1 OpenAPI emission", "pending"),
  item("cafe", 2, "Deploy 0.9.2 to prod", "finished"),
  item("cafe", 3, "Verify prod health (TCP + HTTP)", "finished"),

  item("agencyzero", 0, "Solid + @pathscale/ui frontend scaffold", "pending"),
  item("agencyzero", 1, "Replace static dist/index.html", "pending"),
  item("agencyzero", 2, "Land design/ exports in the repo", "pending"),
  item("agencyzero", 3, "Tauri GUI harness bring-up", "finished"),
];

/** Defaults every fixture message shares, so each one below states only what differs. */
const base = {
  itemId: null,
  agent: "claude" as const,
  moderation: null,
  permission: "edit" as const,
  usage: null,
  stop: "completed" as const,
  exitCode: null,
};

export const MESSAGES: Message[] = [
  // — WorkTable: a plan, a moderator summary, and a go-ahead ————————————
  {
    ...base,
    id: "wt-1",
    projectId: "worktable",
    author: "user",
    model: "sonnet",
    body: "Review the WorkTable upgrade and propose a plan before you touch anything.",
    createdAt: ago(22 * 60_000),
  },
  {
    ...base,
    id: "wt-2",
    projectId: "worktable",
    author: "agent",
    model: "sonnet",
    usage: {
      tokens: 12_400,
      contextTokens: 20500,
      contextWindow: 200_000,
      cacheReads: 8_100,
      reasoningTokens: null,
      costUsd: 0.011,
      premiumRequests: null,
      durationMs: 4_200,
    },
    body: [
      "**Phase A — safety quick-wins**, zero perf cost, no design questions: one PR, small each. Guard, rollback, yield, cycle bound with an honest corrupt-TOC error, then the nits in `into_values`. Ships as 0.9.3.",
      "**Phase B — engine observability**: join-handle plus panic propagation on `wait_for_ops()` — a small API break.",
      "**Phase C — performance, measured**: benches first, then the biggest cheap win, and only then the rewrite with numbers in hand.",
    ].join("\n\n"),
    createdAt: ago(21 * 60_000),
  },
  {
    ...base,
    id: "wt-3",
    projectId: "worktable",
    author: "moderator",
    model: "haiku",
    permission: "read_only",
    moderation: {
      verdict: "noted",
      severity: null,
      toolCallId: null,
      reason:
        "Ran 6 tool calls unattended — 5 inside the working directories, 1 network read to crates.io. Nothing outside policy; no action needed from you.",
      needsApproval: false,
      policy: null,
    },
    body: "",
    createdAt: ago(20 * 60_000),
  },
  {
    ...base,
    id: "wt-4",
    projectId: "worktable",
    author: "user",
    model: "sonnet",
    body: "Start with A. Written proposal before any reader-model code.",
    createdAt: ago(4 * 60_000),
  },
  {
    ...base,
    id: "wt-5",
    projectId: "worktable",
    author: "agent",
    model: "sonnet",
    usage: {
      tokens: 18_700,
      contextTokens: 29900,
      contextWindow: 200_000,
      cacheReads: 11_200,
      reasoningTokens: null,
      costUsd: 0.017,
      premiumRequests: null,
      durationMs: 4_200,
    },
    body: "Understood — A only, and I'll put the reader model in writing before it becomes code. Running the guard tests now.",
    createdAt: ago(3 * 60_000),
  },

  // — api.support.cafe: a CRITICAL hold, still waiting on a decision ————
  {
    ...base,
    id: "cafe-1",
    projectId: "cafe",
    author: "user",
    model: "haiku",
    permission: "read_only",
    body: "Run the legacy-data scan against the prod snapshot.",
    createdAt: ago(14 * 60_000),
  },
  {
    ...base,
    id: "cafe-2",
    projectId: "cafe",
    author: "agent",
    model: "haiku",
    permission: "read_only",
    usage: {
      tokens: 4_100,
      contextTokens: 6100,
      contextWindow: 200_000,
      cacheReads: 2_000,
      reasoningTokens: null,
      costUsd: 0.003,
      premiumRequests: null,
      durationMs: 4_200,
    },
    body: "Snapshot is mounted read-only at `~/snapshots/prod-0.9.2`. Starting the scan — it will take a few minutes over 412k rows.",
    createdAt: ago(13 * 60_000),
  },
  {
    ...base,
    id: "cafe-3",
    projectId: "cafe",
    author: "moderator",
    model: "haiku",
    permission: "read_only",
    moderation: {
      verdict: "blocked",
      severity: "critical",
      toolCallId: "tc-cafe-rm",
      reason:
        "Stopped `rm -rf ./snapshots/tmp` — the path is outside this project's working directories, and bypass mode would have run it. The agent is holding until you decide.",
      needsApproval: true,
      policy: "confine_to_dirs",
    },
    body: "",
    createdAt: ago(11 * 60_000),
  },
  {
    ...base,
    id: "cafe-4",
    projectId: "cafe",
    author: "agent",
    model: "haiku",
    permission: "read_only",
    stop: "error",
    body: "Paused. The scan itself is unaffected; only the cleanup step is blocked.",
    createdAt: ago(11 * 60_000),
  },
];

export const RUNNING: RunningTask[] = [
  {
    toolCallId: "tc-wt-test",
    projectId: "worktable",
    itemId: "worktable-0",
    name: "Bash",
    label: "cargo test -p az-core",
    startedAt: ago(41_000),
    isCancelable: true,
  },
  {
    toolCallId: "tc-wt-rg",
    projectId: "worktable",
    itemId: "worktable-0",
    name: "Search",
    label: "rg reinsert_on_update",
    startedAt: ago(3_000),
    isCancelable: true,
  },
  {
    toolCallId: "tc-cafe-scan",
    projectId: "cafe",
    itemId: "cafe-0",
    name: "Bash",
    label: "legacy-scan --dry-run",
    startedAt: ago(72_000),
    isCancelable: true,
  },
];

const logEntry = (
  projectId: string,
  index: number,
  label: string,
  tool: string,
  ok: boolean,
  durationMs: number | null,
  exitCode: number | null,
): TaskLogEntry => ({
  id: `${projectId}-log-${index}`,
  // History from before this session; nothing left to correlate it to.
  toolCallId: null,
  projectId,
  itemId: null,
  label,
  tool,
  ok,
  output: "",
  durationMs,
  exitCode,
  finishedAt: ago((index + 1) * 6 * 60_000),
});

export const TASK_LOG: TaskLogEntry[] = [
  logEntry("worktable", 0, "cargo build --release", "Bash", true, 41_200, 0),
  logEntry("worktable", 1, "Publish worktable 0.9.2", "Bash", true, 8_100, 0),
  logEntry("worktable", 2, "Bump to 0.9.2, verify build/test/lint", "Bash", false, null, 101),
  logEntry("worktable", 3, "Rebase-merge PR 176", "Bash", true, 3_400, 0),
  logEntry("worktable", 4, "Push main, get deploy run id", "Bash", true, 1_200, 0),
  logEntry("worktable", 5, "Commit release 0.9.2, tag", "Bash", true, 2_000, 0),

  logEntry("cafe", 0, "deploy.sh --env prod", "Bash", true, 41_200, 0),
  logEntry("cafe", 1, "Health check: TCP + HTTP 200", "Bash", true, 600, 0),
  logEntry("cafe", 2, "legacy-data scan (first attempt)", "Bash", false, null, 2),

  logEntry("agencyzero", 0, "cargo tauri build", "Bash", true, 134_000, 0),
];

/**
 * The task log is paginated in the real API, so the panel shows a total that is
 * larger than the rows it holds. These are the mockup's counts.
 */
export const LOG_TOTALS: Record<string, number> = {
  worktable: 91,
  cafe: 12,
  agencyzero: 4,
};

export const AGENT_STATUS: AgentStatus[] = [
  {
    agent: "claude",
    state: "connected",
    version: "2.1.205",
    minVersion: "2.1.100",
    caps: ["fork", "session id"],
    capabilities: {
      session: true,
      fork: true,
      events: true,
      nativeSystem: true,
      commands: true,
      liveFollowUp: true,
      approvals: true,
    },
    checkedAt: ago(2 * 60_000),
  },
  {
    agent: "copilot",
    state: "outdated",
    version: "1.0.61",
    minVersion: "1.0.75",
    caps: ["session id"],
    capabilities: {
      session: true,
      fork: false,
      events: true,
      nativeSystem: false,
      commands: false,
      liveFollowUp: false,
      approvals: false,
    },
    checkedAt: ago(2 * 60_000),
  },
  {
    agent: "codex",
    state: "logged_out",
    version: null,
    minVersion: "0.9.0",
    caps: ["thread id"],
    capabilities: {
      session: true,
      fork: false,
      events: true,
      nativeSystem: false,
      commands: false,
      liveFollowUp: true,
      approvals: true,
    },
    checkedAt: ago(2 * 60_000),
  },
];

/**
 * The catalogues as `agent-abstraction` 0.2.2 compiles them in.
 *
 * Transcribed from the crate rather than invented, so the mock picker shows the
 * same entries the Rust path will. `source` records the weakest evidence behind
 * any entry in that agent's list, which is why Claude reads `docs` even though
 * its aliases were read from a picker.
 */
export const MODEL_CATALOGUE: AgentModels[] = [
  {
    agent: "claude",
    source: "docs",
    checked: "2026-07-29",
    against: "claude 2.1.212",
    discovered: false,
    models: [
      alias("default", "Default", "Whatever is recommended for this account", true),
      alias("opus", "Opus", "Latest Opus, for complex reasoning"),
      alias("sonnet", "Sonnet", "Latest Sonnet, for daily coding"),
      alias("haiku", "Haiku", "Fast and efficient, for simple tasks"),
      alias("fable", "Fable", "For the hardest and longest-running tasks"),
      alias("best", "Best available", "Fable where the organization has it, otherwise Opus"),
      alias("opusplan", "Opus, then Sonnet", "Opus while planning, Sonnet to execute (a mode)"),
      alias("opus[1m]", "Opus (1M context)", "Opus with a 1M token window (a variant)"),
      alias("sonnet[1m]", "Sonnet (1M context)", "Sonnet with a 1M token window (a variant)"),
      pinned(
        "claude-opus-4-8",
        "Claude Opus 4.8",
        "Pinned Claude Opus 4.8, independent of the moving Opus alias",
      ),
      pinned("claude-opus-5", "Claude Opus 5", "For complex agentic coding and enterprise work"),
      pinned(
        "claude-sonnet-5",
        "Claude Sonnet 5",
        "The best combination of speed and intelligence",
      ),
      pinned(
        "claude-fable-5",
        "Claude Fable 5",
        "Next-generation intelligence for long-running agents",
      ),
      pinned(
        "claude-haiku-4-5",
        "Claude Haiku 4.5",
        "The fastest model with near-frontier intelligence",
      ),
    ],
  },
  {
    agent: "codex",
    source: "cli",
    checked: "2026-07-29",
    against: "codex-cli 0.145.0",
    discovered: false,
    models: [
      pinned("gpt-5.6-sol", "GPT-5.6-Sol", "Latest frontier agentic coding model.", FULL, true),
      pinned(
        "gpt-5.6-terra",
        "GPT-5.6-Terra",
        "Balanced agentic coding model for everyday work.",
        FULL,
      ),
      pinned("gpt-5.6-luna", "GPT-5.6-Luna", "Fast and affordable agentic coding model.", TO_MAX),
      pinned("gpt-5.5", "GPT-5.5", "Frontier model for complex coding and research.", TO_XHIGH),
      pinned("gpt-5.4", "GPT-5.4", "Strong model for everyday coding.", TO_XHIGH),
      pinned("gpt-5.4-mini", "GPT-5.4-Mini", "Small, fast, cost-efficient model.", TO_XHIGH),
    ],
  },
  {
    agent: "copilot",
    source: "picker",
    checked: "2026-07-29",
    against: "Copilot CLI 1.0.75",
    discovered: false,
    models: [
      alias("auto", "Auto", "Copilot picks the best available model for each task", true),
      // The picker shows ids and nothing else, so these carry no vendor note.
      ...[
        ["claude-sonnet-5", "Claude Sonnet 5"],
        ["claude-sonnet-4.6", "Claude Sonnet 4.6"],
        ["claude-sonnet-4.5", "Claude Sonnet 4.5"],
        ["claude-haiku-4.5", "Claude Haiku 4.5"],
        ["claude-fable-5", "Claude Fable 5"],
        ["claude-opus-5", "Claude Opus 5"],
        ["claude-opus-4.8", "Claude Opus 4.8"],
        ["claude-opus-4.8-fast", "Claude Opus 4.8 (fast)"],
        ["claude-opus-4.7", "Claude Opus 4.7"],
        ["claude-opus-4.6", "Claude Opus 4.6"],
        ["claude-opus-4.5", "Claude Opus 4.5"],
        ["gpt-5.6-sol", "GPT-5.6-Sol"],
        ["gpt-5.6-terra", "GPT-5.6-Terra"],
        ["gpt-5.6-luna", "GPT-5.6-Luna"],
        ["gpt-5.5", "GPT-5.5"],
        ["gpt-5.4", "GPT-5.4"],
        ["gpt-5.3-codex", "GPT-5.3-Codex"],
        ["gpt-5.4-mini", "GPT-5.4-Mini"],
        ["gpt-5-mini", "GPT-5 mini"],
        ["gemini-3.1-pro-preview", "Gemini 3.1 Pro (preview)"],
        ["gemini-3.6-flash", "Gemini 3.6 Flash"],
        ["gemini-3.5-flash", "Gemini 3.5 Flash"],
        ["kimi-k2.7-code", "Kimi K2.7 Code"],
      ].map(([id, name]) => pinned(id, name, "")),
    ],
  },
];

export const PULL_REQUESTS: PullRequest[] = [
  {
    id: "pr-1",
    projectId: "agencyzero",
    url: "https://github.com/pathscale/agencyzero/pull/16",
    repo: "pathscale/agencyzero",
    number: 16,
    branch: "fix/home-list-ergonomics",
    state: "OPEN",
    additions: 185,
    deletions: 40,
    ci: "pending",
    dismissed: false,
  },
  {
    id: "pr-2",
    projectId: "agencyzero",
    url: "https://github.com/pathscale/agencyzero/pull/2",
    repo: "pathscale/agencyzero",
    number: 2,
    branch: "feat/workspace-scaffold",
    state: "MERGED",
    additions: 812,
    deletions: 44,
    ci: "pass",
    dismissed: false,
  },
];

export const QUESTIONS: Question[] = [
  // On `cafe`, whose moderation hold the tab-status tests resolve first: with
  // the hold cleared, this blocking question is what keeps the tab red, and
  // answering it is what finally lets it go quiet.
  {
    id: "q-block",
    projectId: "cafe",
    text: "Fork codex, or keep patching the integration?",
    urgency: "blocking",
    answered: false,
    createdAt: "2026-08-05T00:00:00Z",
  },
];

export const SETTINGS: GlobalSettings = {
  defaultAgent: "claude",
  // Empty is "not chosen yet". Rust resolves it to $HOME/AgencyZero on read.
  workspaceRoot: "",
  /*
   * A deliberately short starting selection out of a long catalogue: the four
   * Claude aliases that are actually models, Codex's top three, and the only
   * Copilot id a Free plan permits. The rest are one checkbox away in Settings.
   */
  models: {
    claude: {
      enabled: ["default", "opus", "sonnet", "haiku", "opus[1m]", "sonnet[1m]"],
      default: "sonnet",
    },
    codex: {
      enabled: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
      default: "gpt-5.6-sol",
    },
    copilot: { enabled: ["auto"], default: "auto" },
  },
  defaultPermission: "read_only",
  defaultEffort: "high",
  moderator: {
    enabled: true,
    model: "claude:haiku",
    sees: ["transcript", "events"],
    onCheck: "hold_step",
    onCritical: "cancel_run",
    confineToDirs: true,
  },
  // Deliberately not the prompt's model: a list keeper running unattended
  // wants a cheap fast model far more often than a frontier one.
  taskManager: {
    agent: "codex",
    model: "gpt-5.6-luna",
    effort: "low",
    permission: "ask",
    dirs: [],
  },
  envPolicy: "minimal",
  forwardProxyVars: false,
  costWarningUsd: 0.75,
  completedItems: "resolve",
  agentFinishedRetentionTurns: 1,
  theme: { surface: "", accent: "", softness: 0, wash: 30, textBrightness: 0 },
  studyAnalytics: { enabled: false, sessionId: "", enabledAt: "" },
  perTurnInjection: true,
  automaticUpdateChecks: true,
  agentSettingsUpdates: false,
  agentRestartPolicy: "disabled",
  workspaceTabs: null,
  onboardingCompleted: true,
  uiPreferences: {},
  uiPreferencesRevision: "",
  review: { prompt: "", models: {} },
  notifications: {
    onHold: true,
    onRunFinished: true,
    onTaskFailed: true,
    onRateLimited: true,
    sound: false,
  },
};

/**
 * The mockup shows api.support.cafe rate-limited, which is what turns its tab
 * dot amber and puts the "Rate limited · resets 14:20" pill in its header.
 */
export const RATE_LIMITS: Record<
  string,
  { agent: Agent; isBlocking: boolean; isWarning: boolean; message: string; resetsAt: string }
> = {
  cafe: {
    // A real refusal, not the "allowed" heartbeat the provider also emits.
    agent: "claude",
    isBlocking: true,
    isWarning: false,
    message: "Rate limited",
    resetsAt: new Date(now + 34 * 60_000).toISOString(),
  },
};

/**
 * Makes the mock's Claude usage read reject, for backoff coverage.
 *
 * Claude usage is the one read whose failure path carries behaviour of its own,
 * and the mock is otherwise incapable of producing a rejection there.
 */
export let CLAUDE_USAGE_ERROR: string | null = null;

export function setClaudeUsageError(message: string | null): void {
  CLAUDE_USAGE_ERROR = message;
}
