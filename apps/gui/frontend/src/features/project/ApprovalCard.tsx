import { type JSX, Show } from "solid-js";
import { Icon } from "~/components/Icon";
import { describeError, log } from "~/lib/log";
import { useWorkspace } from "~/stores/workspace";
import type { PendingApproval } from "~/types";

/**
 * A tool call waiting on the user, with Allow/Deny carried in place.
 *
 * The run is blocked mid-turn until this is answered, so the card renders in
 * the transcript (and on Home for the task manager) rather than in a
 * diagnostic panel — a question nobody sees is a question nobody answers, and
 * an unanswered one becomes a denial on timeout.
 *
 * The input is shown, not just the tool name: for `Bash` the command lives in
 * the input, and approving on the name alone approves an unseen command.
 */
export function ApprovalCard(props: { projectId: string; approval: PendingApproval }): JSX.Element {
  const { actions } = useWorkspace();

  const answer = (allow: boolean, remember = false): void => {
    void actions
      .resolveApproval(props.projectId, props.approval.approvalId, allow, remember)
      .catch((cause) => log.error(`could not deliver the decision: ${describeError(cause)}`));
  };

  /** The one-line summary a decision can be made on, when the input has one. */
  const headline = (): string | null => {
    const input = props.approval.input;
    if (input && typeof input === "object") {
      const record = input as Record<string, unknown>;
      for (const key of ["command", "file_path", "path", "url"]) {
        if (typeof record[key] === "string") return record[key] as string;
      }
    }
    return null;
  };

  const detail = (): string => JSON.stringify(props.approval.input, null, 2) ?? "";

  return (
    <div class="flex gap-[11px] rounded-xl border border-warning/26 border-l-2 border-l-warning bg-warning/9 p-[11px_13px]">
      <Icon name="lock" class="relative top-0.5 shrink-0 text-[15px] text-warning" />
      <div class="flex min-w-0 flex-1 flex-col gap-[7px]">
        <div class="flex items-baseline gap-2">
          <span class="font-semibold text-[12px] text-warning">Approval needed</span>
          <span class="font-mono text-[11.5px] text-az-muted">{props.approval.tool}</span>
        </div>

        <Show when={headline()}>
          {(line) => (
            <code
              data-selectable
              class="block truncate rounded-md bg-base-300 px-2 py-1 font-mono text-[12px] text-az-strong"
              title={line()}
            >
              {line()}
            </code>
          )}
        </Show>

        {/* The full arguments, exactly as the agent sent them. */}
        <pre
          data-selectable
          class="az-scroll max-h-[140px] overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-base-300/60 px-2 py-1 font-mono text-[10.5px] text-az-body"
        >
          {detail()}
        </pre>

        <div class="flex items-center gap-2 pt-0.5">
          <button
            type="button"
            onClick={() => answer(true)}
            class="rounded-lg bg-primary px-[13px] py-[5px] font-semibold text-[12px] text-primary-content transition-colors hover:bg-az-primary-hover"
          >
            Allow once
          </button>
          <button
            type="button"
            onClick={() => answer(true, true)}
            /*
             * The teach verb. Rust remembers this call's signature for the
             * project — Bash rules are program + subcommand, file rules the
             * parent directory — and answers matching asks itself from now
             * on, each auto-allow audited in the Agent I/O panel.
             */
            title="Remembers this kind of call for this project — the same command family or the same directory — and allows it automatically from now on"
            class="rounded-lg border border-primary/50 px-3 py-[5px] font-semibold text-[12px] text-primary transition-colors hover:border-primary hover:bg-primary/10"
          >
            Always allow similar
          </button>
          <button
            type="button"
            onClick={() => answer(false)}
            class="rounded-lg border border-white/18 px-3 py-[5px] text-[12px] text-az-body transition-colors hover:border-error hover:text-error"
          >
            Deny
          </button>
          <span class="text-[11.5px] text-az-muted">· the run is paused until you decide</span>
        </div>
      </div>
    </div>
  );
}
