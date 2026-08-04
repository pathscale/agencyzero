import { createMemo, type JSX, Show } from "solid-js";
import { Icon } from "~/components/Icon";
import { tx } from "~/stores/i18n";
import { useWorkspace } from "~/stores/workspace";

export type CloseConfirmProps = {
  isOpen: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * "Quit AgencyZero?" — the one gate on the way out.
 *
 * Quitting drops every Run the window is supervising, and killing a run kills
 * its whole process group, so this counts what is actually in flight and says
 * so rather than asking a generic "are you sure?". A confirmation that cannot
 * tell you what you are about to lose trains you to dismiss it.
 */
export function CloseConfirm(props: CloseConfirmProps): JSX.Element {
  const { state } = useWorkspace();

  const runningCount = createMemo(() =>
    Object.values(state.running).reduce((total, tasks) => total + tasks.length, 0),
  );

  const heldCount = createMemo(
    () =>
      Object.values(state.messages).filter((messages) =>
        messages.some((message) => message.moderation?.needsApproval),
      ).length,
  );

  return (
    <Show when={props.isOpen}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-confirm-title"
        class="absolute inset-0 z-50 flex items-center justify-center bg-black/55 p-8 backdrop-blur-[2px]"
        onClick={(event) => event.currentTarget === event.target && props.onCancel()}
        onKeyDown={(event) => event.key === "Escape" && props.onCancel()}
      >
        <div class="az-ring w-full max-w-[420px] rounded-[17px]">
          <div class="flex flex-col gap-3.5 rounded-2xl bg-az-inset p-5">
            <div class="flex items-baseline gap-2.5">
              <Icon name="info" class="relative top-0.5 text-[15px] text-primary" />
              <h2 id="close-confirm-title" class="font-semibold text-[14.5px] text-az-title">
                {tx("Work is still in progress")}
              </h2>
            </div>

            <p class="text-[12.5px] text-az-body leading-[1.55]">
              <Show
                when={runningCount() > 0 || heldCount() > 0}
                fallback={tx("Nothing is running. Your projects and their items are saved.")}
              >
                <Show when={runningCount() > 0}>
                  <span class="text-primary">
                    {tx(
                      runningCount() === 1
                        ? "{count} task is still running"
                        : "{count} tasks are still running",
                      { count: runningCount() },
                    )}
                  </span>
                  {heldCount() > 0 ? ", and " : ". "}
                </Show>
                <Show when={heldCount() > 0}>
                  <span class="text-warning">
                    {tx(
                      heldCount() === 1
                        ? "{count} project is holding on your approval"
                        : "{count} projects are holding on your approval",
                      { count: heldCount() },
                    )}
                  </span>
                  {". "}
                </Show>
                {tx("Quitting cancels every run and its whole process group.")}
              </Show>
            </p>

            <div class="flex items-center justify-end gap-2 pt-0.5">
              <button
                type="button"
                onClick={props.onCancel}
                class="rounded-lg border border-az-hairline-strong px-3.5 py-1.5 text-[12.5px] text-az-body transition-colors hover:border-primary/30 hover:text-az-title"
              >
                {tx("Wait for completion")}
              </button>
              <button
                type="button"
                autofocus
                onClick={props.onConfirm}
                class="rounded-lg bg-primary px-3.5 py-1.5 font-semibold text-[12.5px] text-primary-content transition-colors hover:bg-az-primary-hover"
              >
                {tx("Exit now")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
