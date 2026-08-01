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
 * `pending` and `canceled` are deliberately not on it. `pending` is the legacy
 * value every old row carries and the ladder's job is to get rows off it;
 * `canceled` is an ending, and cycling into it by clicking past `finished`
 * would retire work by accident.
 */
export const ITEM_LADDER: ProjectStatus[] = [
  "new",
  "planning",
  "active",
  "questions",
  "shipped",
  "finished",
];

/** The next status a click on the marker means. */
export function nextStatus(status: ProjectStatus): ProjectStatus {
  const at = ITEM_LADDER.indexOf(status);
  // Off the ladder, including `pending`: the first rung is where it belongs.
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
