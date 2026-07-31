import { type JSX, Show } from "solid-js";
import type { AgentState, TabStatus } from "~/types";

/*
 * Four meanings, four colours:
 *
 *   green  ready   — active and idle, waiting for you
 *   amber  running — the agent is thinking, replying or running a tool
 *   red    blocked — it needs you: a moderation hold, or a live rate limit
 *   red    error   — a critical hold, which cancelled the run
 *   grey   quiet   — inactive: finished, cancelled, or not started
 *
 * `ready` and `quiet` were one grey state, so a project waiting on you looked
 * exactly like one you had closed out. Splitting them is the whole point of the
 * green.
 *
 * `blocked` is red rather than the amber it used to be, because amber now means
 * "busy" and a hold means "you". That is a deliberate departure from
 * `design/data-model.html`, which maps a check-severity hold to amber and only a
 * critical one to red — see the frontend README.
 */
const TAB_DOT: Record<TabStatus, string> = {
  ready: "bg-success",
  running: "bg-warning",
  blocked: "bg-error",
  error: "bg-error",
  quiet: "bg-white/25",
};

const TAB_HALO: Record<TabStatus, string> = {
  ready: "az-halo-success",
  running: "az-halo-warning",
  blocked: "az-halo-error",
  error: "az-halo-error",
  quiet: "",
};

export type StatusDotProps = {
  status: TabStatus;
  /**
   * A halo marks a state that is live right now. The idle copy of a tab — and
   * every row in a historic list — wears the same colour without it, so the
   * eye lands on what is actually happening.
   */
  live?: boolean;
  size?: number;
  class?: string;
};

/** The dot that carries a tab's state: ready · running · blocked · error · quiet. */
export function StatusDot(props: StatusDotProps): JSX.Element {
  return (
    <span
      class={`shrink-0 rounded-full ${TAB_DOT[props.status]} ${props.live ? TAB_HALO[props.status] : ""} ${props.class ?? ""}`}
      style={{ width: `${props.size ?? 6}px`, height: `${props.size ?? 6}px` }}
    />
  );
}

const AGENT_DOT: Record<AgentState, { dot: string; halo: string }> = {
  connected: { dot: "bg-success", halo: "az-halo-success" },
  outdated: { dot: "bg-warning", halo: "az-halo-warning" },
  logged_out: { dot: "bg-error", halo: "az-halo-error" },
  missing: { dot: "bg-white/25", halo: "" },
};

/** Green · amber · red · grey, one per detected agent CLI in Settings. */
export function AgentStateDot(props: { state: AgentState }): JSX.Element {
  return (
    <span
      class={`size-2 shrink-0 rounded-full ${AGENT_DOT[props.state].dot} ${AGENT_DOT[props.state].halo}`}
    />
  );
}

/** The checkbox-ish marker on an item row: filled, hollow or ticked. */
export function ItemMarker(props: { status: "pending" | "active" | "finished" }): JSX.Element {
  return (
    <Show
      when={props.status !== "active"}
      fallback={
        <span class="az-halo-primary relative top-[3px] size-2 shrink-0 rounded-full bg-primary" />
      }
    >
      <span class="relative top-[3px] size-2 shrink-0 rounded-full border-[1.5px] border-primary/30" />
    </Show>
  );
}
