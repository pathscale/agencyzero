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
  edit: "Edit",
  auto: "Auto",
  bypass: "Bypass",
};

/** Ordered least to most permissive — the order the composer offers them in. */
export const PERMISSION_ORDER: Permission[] = ["read_only", "plan", "edit", "auto", "bypass"];

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

/** The "(…)" suffix on a project or item row. */
export function statusSuffix(status: ProjectStatus): string {
  return `(${status.charAt(0).toUpperCase()}${status.slice(1)})`;
}

/** Models the composer offers. Real values will come from the agent probe. */

/**
 * A running task and a finished one carry the same label but different shapes;
 * the two panels render identically, so they read the label the same way.
 */
export function taskLabel(task: RunningTask | TaskLogEntry): string {
  return task.label;
}
