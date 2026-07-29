import { type JSX, Show } from "solid-js";
import type { AgentState, TabStatus } from "~/types";

const TAB_DOT: Record<TabStatus, string> = {
  running: "bg-primary",
  blocked: "bg-warning",
  error: "bg-error",
  quiet: "bg-white/25",
};

const TAB_HALO: Record<TabStatus, string> = {
  running: "az-halo-primary",
  blocked: "az-halo-warning",
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

/** The dot that carries a tab's state: running · blocked · error · quiet. */
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
      <span class="relative top-[3px] size-2 shrink-0 rounded-full border-[1.5px] border-white/30" />
    </Show>
  );
}
