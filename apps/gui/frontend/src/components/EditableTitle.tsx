import { InlineEdit } from "@pathscale/ui";
import type { JSX } from "@solidjs/web";
import { Icon } from "~/components/Icon";
import { describeError, log } from "~/lib/log";
import { tx } from "~/stores/i18n";

/**
 * A name that can be edited in place.
 *
 * The interaction belongs to `InlineEdit`; what stays here is this
 * application's shape of it: the pencil, the reporting of a failed rename, and
 * the accessible names, which are translated.
 */
export function EditableTitle(props: {
  value: string;
  onRename: (name: string) => Promise<unknown>;
  class?: string;
  inputClass?: string;
  label?: string;
  onActivate?: () => void;
}): JSX.Element {
  const rename = async (name: string): Promise<void> => {
    try {
      await props.onRename(name);
    } catch (cause) {
      // The typed name is already gone from the field by this point, so the
      // log line is the only record of what was attempted.
      log.error(`could not rename to "${name}": ${describeError(cause)}`);
    }
  };

  return (
    <InlineEdit
      value={props.value}
      onCommit={rename}
      label={props.label ?? tx("Rename {name}", { name: props.value })}
      trigger={<Icon name="pencil" class="text-[11px]" />}
      class={props.class}
      fieldClass={props.inputClass}
    >
      {props.onActivate ? (
        <button
          type="button"
          onClick={() => props.onActivate?.()}
          aria-label={tx("Open project {name}", { name: props.value })}
          class="min-w-0 truncate text-left"
        >
          {props.value}
        </button>
      ) : undefined}
    </InlineEdit>
  );
}
