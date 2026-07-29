import type {
  AgentStatus,
  GlobalSettings,
  Message,
  Project,
  ProjectItem,
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
    lastActivityAt: ago(26 * 60 * 60_000),
  },
];

const item = (
  projectId: string,
  order: number,
  title: string,
  status: ProjectItem["status"],
): ProjectItem => ({ id: `${projectId}-${order}`, projectId, title, status, order });

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
    usage: { tokens: 12_400, cacheReads: 8_100, costUsd: 0.011, premiumRequests: null },
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
    usage: { tokens: 18_700, cacheReads: 11_200, costUsd: 0.017, premiumRequests: null },
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
    usage: { tokens: 4_100, cacheReads: 2_000, costUsd: 0.003, premiumRequests: null },
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
    checkedAt: ago(2 * 60_000),
  },
  {
    agent: "copilot",
    state: "outdated",
    version: "1.0.61",
    minVersion: "1.0.75",
    caps: ["session id"],
    checkedAt: ago(2 * 60_000),
  },
  {
    agent: "codex",
    state: "logged_out",
    version: null,
    minVersion: "0.9.0",
    caps: ["thread id"],
    checkedAt: ago(2 * 60_000),
  },
];

export const SETTINGS: GlobalSettings = {
  defaultAgent: "claude",
  defaultModel: "sonnet",
  defaultPermission: "read_only",
  moderator: {
    enabled: true,
    model: "haiku",
    sees: ["transcript", "events"],
    onCheck: "hold_step",
    onCritical: "cancel_run",
    confineToDirs: true,
  },
  envPolicy: "minimal",
  forwardProxyVars: false,
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
export const RATE_LIMITS: Record<string, { message: string; resetsAt: string }> = {
  cafe: {
    message: "Rate limited",
    resetsAt: new Date(now + 34 * 60_000).toISOString(),
  },
};
