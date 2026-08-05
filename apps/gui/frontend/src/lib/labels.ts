import { tx, type UiMessage } from "~/stores/i18n";
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

export const permissionLabel = (permission: Permission): string =>
  tx(PERMISSION_LABELS[permission] as UiMessage);

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

export const agentStateLabel = (state: AgentState): string =>
  tx(AGENT_STATE_LABELS[state] as UiMessage);

export const ENV_POLICY_LABELS: Record<EnvPolicy, string> = {
  minimal: "Minimal",
  inherit: "Inherit",
};

export const envPolicyLabel = (policy: EnvPolicy): string =>
  tx(ENV_POLICY_LABELS[policy] as UiMessage);

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

export const statusLabel = (status: ProjectStatus): string =>
  tx(STATUS_LABELS[status] as UiMessage);

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
  return `(${statusLabel(status)})`;
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

/**
 * The rungs a marker click cycles through: the working states only.
 *
 * `finished` and `canceled` are left out on purpose. They are terminal, and
 * under the default `completed_items` handling a row that reaches one drops out
 * of the open list, so a click that lands there reads as the row being deleted.
 * The cycle now loops shipped back to new and stays in the visible set; the end
 * states are still reachable through the owner's own finish/cancel path, just
 * not by this toggle.
 */
const CYCLE_LADDER: ProjectStatus[] = [
  "new",
  "pending",
  "planning",
  "active",
  "questions",
  "shipped",
];

/** The next status a click on the marker means. */
export function nextStatus(status: ProjectStatus): ProjectStatus {
  const at = CYCLE_LADDER.indexOf(status);
  // A terminal or unknown state re-enters the cycle at the first rung rather
  // than advancing off the end into another terminal state.
  return at === -1 ? "new" : (CYCLE_LADDER[(at + 1) % CYCLE_LADDER.length] ?? "new");
}

/** Models the composer offers. Real values will come from the agent probe. */

/**
 * A running task and a finished one carry the same label but different shapes;
 * the two panels render identically, so they read the label the same way.
 */
export function taskLabel(task: RunningTask | TaskLogEntry): string {
  return task.label;
}
