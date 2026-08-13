import { Modal } from "@pathscale/ui";
import { createMemo, type JSX, Show } from "solid-js";
import { Button } from "~/components/Button";
import { Icon } from "~/components/Icon";
import { tx } from "~/stores/i18n";
import { useWorkspace } from "~/stores/workspace";

export type CloseConfirmProps = {
  isOpen: boolean;
  error?: string;
  quitsProxy?: boolean;
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

  // Optional chaining because a purged project can leave one record with a key
  // another lacks, so a value can be absent under an existing key.
  const runningCount = createMemo(() =>
    Object.values(state.running).reduce((total, tasks) => total + (tasks?.length ?? 0), 0),
  );

  const heldCount = createMemo(
    () =>
      Object.values(state.messages).filter((messages) =>
        messages?.some((message) => message.moderation?.needsApproval),
      ).length,
  );

  return (
    <Show when={props.isOpen}>
      <Modal
        isOpen
        onOpenChange={(isOpen) => !isOpen && props.onCancel()}
        placement="center"
        size="md"
        backdrop="opaque"
      >
        <Modal.Content
          aria-labelledby="close-confirm-title"
          class="az-ring w-full max-w-[420px] rounded-[17px] bg-transparent p-0 shadow-none"
        >
          <div class="flex flex-col gap-3.5 rounded-2xl bg-az-inset p-5">
            <Modal.Header class="flex-row items-baseline gap-2.5">
              <Icon name="info" class="relative top-0.5 text-[15px] text-primary" />
              <Modal.Heading
                id="close-confirm-title"
                class="font-semibold text-[14.5px] text-az-title"
              >
                {tx(
                  props.error
                    ? "Could not safely quit"
                    : props.quitsProxy
                      ? "Quit AgencyZero and AgencyProxy?"
                      : "Work is still in progress",
                )}
              </Modal.Heading>
            </Modal.Header>

            <Modal.Body class="overflow-visible text-[12.5px] text-az-body leading-[1.55]">
              <Show
                when={!props.error}
                fallback={
                  <p
                    data-selectable
                    class="rounded-lg border border-error/25 bg-error/8 p-3 font-mono text-[11.5px] text-error leading-[1.55]"
                  >
                    {props.error}
                  </p>
                }
              >
                <p>
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
                    {tx(
                      props.quitsProxy
                        ? "Quitting both cancels every run and stops AgencyProxy."
                        : "AgencyProxy remains running so active work can continue.",
                    )}
                  </Show>
                </p>
              </Show>
            </Modal.Body>

            <Modal.Footer class="pt-0.5">
              <Button
                type="button"
                onClick={props.onCancel}
                class="rounded-lg border border-az-hairline-strong px-3.5 py-1.5 text-[12.5px] text-az-body transition-colors hover:border-primary/30 hover:text-az-title"
              >
                {tx(props.error ? "Keep AgencyZero open" : "Wait for completion")}
              </Button>
              <Show when={!props.error}>
                <Button
                  type="button"
                  autofocus
                  onClick={props.onConfirm}
                  class="rounded-lg bg-primary px-3.5 py-1.5 font-semibold text-[12.5px] text-primary-content transition-colors hover:bg-az-primary-hover"
                >
                  {tx(props.quitsProxy ? "Quit both" : "Exit now")}
                </Button>
              </Show>
            </Modal.Footer>
          </div>
        </Modal.Content>
      </Modal>
    </Show>
  );
}
