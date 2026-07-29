import { createSignal, type JSX, Show } from "solid-js";
import { Panel } from "~/components/Panel";
import { Composer } from "~/features/project/Composer";
import { useWorkspace } from "~/stores/workspace";
import type { Tab } from "~/types";

/**
 * The Untitled tab: an empty chat and nothing else.
 *
 * No form. The design dropped repository, working directory and agent from
 * project init deliberately — the first message is the only input, and the
 * name and opening items come back from the reply. Working directories are
 * added later, in the project's own Settings section.
 */
export function DraftTab(props: { tab: Tab }): JSX.Element {
  const { actions } = useWorkspace();
  const [isCreating, setIsCreating] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function create(firstMessage: string): Promise<void> {
    setError(null);
    setIsCreating(true);
    try {
      await actions.createProject(firstMessage, props.tab.key);
    } catch (cause) {
      // The draft tab stays open on failure — losing what was typed because
      // the backend hiccuped would be its own bug.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <Panel class="flex min-w-0 flex-1 items-center justify-center p-7">
      <div class="w-full max-w-[620px]">
        <Composer
          size="lg"
          autofocus
          placeholder="Type to start your new project…"
          model={props.tab.model}
          permission={props.tab.permission}
          onModelChange={(model) => actions.setTabModel(props.tab.key, model, props.tab.permission)}
          onPermissionChange={(permission) =>
            actions.setTabModel(props.tab.key, props.tab.model, permission)
          }
          onSend={(body) => void create(body)}
          isRunning={isCreating()}
        />

        <Show when={error()}>
          {(message) => (
            <p role="alert" class="px-2 pt-3 text-[12px] text-error">
              Could not create the project: {message()}
            </p>
          )}
        </Show>
      </div>
    </Panel>
  );
}
