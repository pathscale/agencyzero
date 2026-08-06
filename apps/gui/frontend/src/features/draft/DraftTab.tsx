import type { JSX } from "solid-js";
import { Panel } from "~/components/Panel";
import { Composer } from "~/features/project/Composer";
import { tx } from "~/stores/i18n";
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
  const { actions, promptModels, effortsFor, permissionsFor } = useWorkspace();

  return (
    <Panel class="flex min-w-0 flex-1 items-center justify-center p-7">
      <div class="w-full max-w-[900px]">
        <Composer
          draftKey={props.tab.key}
          size="lg"
          autofocus
          placeholder={tx("Type to start your new project…")}
          agent={props.tab.agent}
          model={props.tab.model}
          modelOptions={promptModels()}
          efforts={effortsFor(props.tab.agent, props.tab.model)}
          effort={props.tab.effort}
          permission={props.tab.permission}
          permissions={permissionsFor(props.tab.agent)}
          onModelChange={(agent, model) =>
            actions.setTabModel(props.tab.key, agent, model, props.tab.permission)
          }
          onPermissionChange={(permission) =>
            actions.setTabModel(props.tab.key, props.tab.agent, props.tab.model, permission)
          }
          // The same omission the project tab had: the effort menu called an
          // optional handler nobody passed, so a picked level never stuck.
          onEffortChange={(effort) =>
            actions.setTabModel(
              props.tab.key,
              props.tab.agent,
              props.tab.model,
              props.tab.permission,
              effort,
            )
          }
          extraThinking={props.tab.extraThinking}
          onExtraThinkingChange={(enabled) => actions.setTabExtraThinking(props.tab.key, enabled)}
          onSend={(body, study) => actions.createProject(body, props.tab.key, study)}
        />
      </div>
    </Panel>
  );
}
