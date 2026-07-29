import type { JSX } from "solid-js";
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
 *
 * Creation failures are the composer's to report: it holds the text until the
 * promise resolves, so a failed create leaves the draft exactly as typed.
 */
export function DraftTab(props: { tab: Tab }): JSX.Element {
  const { actions, promptModels } = useWorkspace();

  return (
    <Panel class="flex min-w-0 flex-1 items-center justify-center p-7">
      <div class="w-full max-w-[620px]">
        <Composer
          size="lg"
          autofocus
          placeholder="Type to start your new project…"
          model={props.tab.model}
          modelOptions={promptModels()}
          permission={props.tab.permission}
          onModelChange={(model) => actions.setTabModel(props.tab.key, model, props.tab.permission)}
          onPermissionChange={(permission) =>
            actions.setTabModel(props.tab.key, props.tab.model, permission)
          }
          onSend={(body) => actions.createProject(body, props.tab.key)}
        />
      </div>
    </Panel>
  );
}
