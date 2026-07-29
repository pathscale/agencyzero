import { For, type JSX } from "solid-js";

/**
 * Enough markdown for what the agent actually emits today: paragraphs,
 * `**bold**` and `` `code` ``.
 *
 * `Message.body` is real markdown, and code blocks, diffs and long tool output
 * all land there — `design/data-model.html` parks proper transcript rendering
 * as an open TODO, to be designed once real output exists. Until then this
 * covers the mockup exactly and nothing more.
 *
 * It builds JSX nodes rather than assigning HTML, so agent output can never
 * become markup in this window.
 */
export function MessageBody(props: { body: string; class?: string }): JSX.Element {
  const paragraphs = () => props.body.split(/\n{2,}/).filter((block) => block.trim().length > 0);

  return (
    <div class={`flex flex-col gap-2.5 ${props.class ?? ""}`} data-selectable>
      <For each={paragraphs()}>{(paragraph) => <p>{renderInline(paragraph)}</p>}</For>
    </div>
  );
}

/**
 * The same inline pass, for a single run of text.
 *
 * Used for `Moderation.reason`, which the model calls plain language but which
 * always names a path or a command — and a bare `rm -rf ./snapshots/tmp` in the
 * middle of a sentence is exactly the thing that needs to stand out.
 */
export function InlineText(props: { text: string }): JSX.Element {
  return <>{renderInline(props.text)}</>;
}

/** Splits on `**bold**` and `` `code` `` while keeping the delimiters' order. */
function renderInline(text: string): JSX.Element[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);

  return parts.filter(Boolean).map((part) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong class="font-semibold text-az-strong">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <InlineCode>{part.slice(1, -1)}</InlineCode>;
    }
    return <>{part}</>;
  });
}

export function InlineCode(props: { children: JSX.Element }): JSX.Element {
  return (
    <code class="rounded-[5px] border border-az-hairline bg-base-300 px-[5px] py-px font-mono text-[12px] text-info">
      {props.children}
    </code>
  );
}
