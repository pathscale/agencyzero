import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Icon } from "~/components/Icon";
import type { AgentState, ProjectStatus, TabStatus } from "~/types";

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

/*
 * One appearance per status.
 *
 * There were two, filled for `active` and hollow for everything else, with the
 * callers folding five statuses into those two on the way in. A row that was
 * proposed, one being planned, one shipped and awaiting a verdict, and one left
 * on the legacy `pending` all looked identical, so clicking the marker cycled a
 * value the marker could not show. The control existed; it had nothing to say.
 */
const ITEM_DOT: Record<ProjectStatus, string> = {
  new: "border-[1.5px] border-primary/30",
  // Legacy, and deliberately the dimmest: it means nobody has classified this.
  pending: "border-[1.5px] border-white/22",
  // Rendered as SVG below. CSS's four-sided dashed border degenerates into
  // one arc and a dot at this size in Blitz.
  planning: "",
  active: "az-halo-primary bg-primary",
  // Amber and haloed: the one state that is asking the reader for something.
  questions: "az-halo-warning border-[1.5px] border-warning bg-warning/45",
  // Amber solid, matching the "(PR #39)" beside it: a claim, not a result.
  shipped: "bg-warning",
  // Unused: `finished` is the tick.
  finished: "",
  canceled: "border-[1.5px] border-white/20 opacity-50",
};

/** The checkbox-ish marker on an item row, one look per status. */
export function ItemMarker(props: { status: ProjectStatus }): JSX.Element {
  return (
    <Show
      when={props.status !== "questions"}
      fallback={<Icon name="circle-help" class="shrink-0 text-[13px] text-warning" />}
    >
      <Show
        when={props.status !== "planning"}
        fallback={<Icon name="circle-dashed" class="shrink-0 text-[12px] text-info" />}
      >
        <Show
          when={props.status !== "finished"}
          fallback={
            <Icon name="check" class="relative top-0.5 shrink-0 text-[12px] text-success" />
          }
        >
          <span class={`size-2 shrink-0 rounded-full ${ITEM_DOT[props.status] ?? ITEM_DOT.new}`} />
        </Show>
      </Show>
    </Show>
  );
}
