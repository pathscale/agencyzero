import type {
  Agent,
  AgentState,
  EnvPolicy,
  Permission,
  ProjectStatus,
  RunningTask,
  TaskLogEntry,
  TaskPlacement,
} from "~/types";

/**
 * Wire value -> what the user reads.
 *
 * The model speaks the crate's vocabulary (`read_only`, `logged_out`); the UI
 * speaks English. Keeping the translation in one place is what stops "Read
 * only", "Read-only" and "readonly" from all appearing on the same screen.
 */

export const PERMISSION_LABELS: Record<Permission, string> = {
  read_only: "Read-only",
  plan: "Plan",
  ask: "Ask",
  edit: "Edit",
  auto: "Auto",
  bypass: "Bypass",
};

/** Ordered least to most permissive — the order the composer offers them in. */
export const PERMISSION_ORDER: Permission[] = [
  "read_only",
  "plan",
  "ask",
  "edit",
  "auto",
  "bypass",
];

export const AGENT_LABELS: Record<Agent, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
};

export const AGENT_STATE_LABELS: Record<AgentState, string> = {
  connected: "connected",
  outdated: "update required",
  logged_out: "not logged in",
  missing: "not installed",
};

export const ENV_POLICY_LABELS: Record<EnvPolicy, string> = {
  minimal: "Minimal",
  inherit: "Inherit",
};

export const TASK_PLACEMENT_LABELS: Record<TaskPlacement, string> = {
  panel: "Right panel",
  dock: "Bottom dock",
  inline: "In the transcript",
};

/**
 * What each status is called on screen.
 *
 * Written out rather than capitalised from the value, because a status is a
 * word chosen for the store and a label is a word chosen for a person, and
 * `questions` capitalised reads as a noun with no verb.
 */
export const STATUS_LABELS: Record<ProjectStatus, string> = {
  new: "New",
  pending: "Pending",
  planning: "Planning",
  active: "Active",
  questions: "Open questions",
  shipped: "Shipped",
  finished: "Finished",
  canceled: "Canceled",
};

/**
 * What a rate-limit chip says, in words.
 *
 * The provider reports a status word and a window name, `allowed_warning
 * (seven_day)`, and neither is English. The window is kept because it says how
 * long the flag lasts; the reset time is dropped, being one more thing to read
 * at a glance that nobody acts on.
 *
 * An unrecognised status falls through unchanged rather than being swallowed. A
 * new status word from the provider should look odd on screen, not disappear.
 */
export function rateLimitLabel(message: string): string {
  const lower = message.toLowerCase();
  const window = /\(([^)]+)\)/.exec(message)?.[1]?.replace(/_/g, " ");
  const suffix = window ? ` (${window})` : "";
  // No percentage is claimed, because none is reported. `RateLimit` carries a
  // status word, a window and a reset time; the threshold behind
  // `allowed_warning` is the provider's and is not in the payload, so a figure
  // on screen would be one this app invented.
  if (lower.includes("allowed_warning")) return `Usage high${suffix}`;
  if (lower.includes("reject") || lower.includes("block")) return `Usage limit reached${suffix}`;
  return message;
}

/** The "(…)" suffix on a project or item row. */
export function statusSuffix(status: ProjectStatus): string {
  return `(${STATUS_LABELS[status] ?? status})`;
}

/**
 * The order the marker cycles through, and the only such order.
 *
 * Home and the project panel each had their own: the panel walked
 * new to planning to active to shipped to finished, and Home walked pending to
 * active to finished, so the same click on the same item did different things
 * depending on which screen you were looking at.
 *
 * Every stored state is reachable manually. The marker is a deliberate button,
 * so the user can correct any agent-authored state without a hidden exception.
 */
export const ITEM_LADDER: ProjectStatus[] = [
  "new",
  "pending",
  "planning",
  "active",
  "questions",
  "shipped",
  "finished",
  "canceled",
];

/** The next status a click on the marker means. */
export function nextStatus(status: ProjectStatus): ProjectStatus {
  const at = ITEM_LADDER.indexOf(status);
  // An unknown future value starts at the first known rung.
  return at === -1 ? "new" : (ITEM_LADDER[(at + 1) % ITEM_LADDER.length] ?? "new");
}

/** Models the composer offers. Real values will come from the agent probe. */

/**
 * A running task and a finished one carry the same label but different shapes;
 * the two panels render identically, so they read the label the same way.
 */
export function taskLabel(task: RunningTask | TaskLogEntry): string {
  return task.label;
}
