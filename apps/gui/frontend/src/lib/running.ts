import type { Agent, RunningTask } from "~/types";

/**
 * The live-turn row the Running panel shows when a run is accepted but no
 * tool is in flight. Fast calls (any agent) finish in the same tick, so the
 * tool list is empty for most of a working turn; this row is what keeps the
 * panel from reading as idle. In-flight tools still win for every agent.
 *
 * Never matches a `task:finished` id — it is derived, not stored.
 */
export const LIVE_TURN_ID = "__turn__";

/** The slice of `RunStatus` the panel needs. Kept local so this file stays store-free. */
export type LiveTurn = {
  agent: Agent;
  activity: string;
  /** Wall-clock ms when the send was accepted. */
  startedAt: number;
};

/**
 * What the Running panel lists: in-flight tools if any, otherwise one row
 * for the live turn. Empty only when nothing is actually running.
 */
export function runningRows(
  projectId: string,
  tools: readonly RunningTask[] | undefined,
  turn: LiveTurn | undefined,
): RunningTask[] {
  const live = tools ?? [];
  if (live.length > 0) return [...live];
  if (!turn) return [];
  return [
    {
      toolCallId: LIVE_TURN_ID,
      projectId,
      itemId: null,
      name: turn.agent,
      label: turn.activity,
      startedAt: new Date(turn.startedAt).toISOString(),
      isCancelable: true,
    },
  ];
}
