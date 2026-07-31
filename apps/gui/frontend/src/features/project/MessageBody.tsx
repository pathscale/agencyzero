import { createSignal, For, type JSX, Show } from "solid-js";
import { Icon } from "~/components/Icon";
import { describeError, log } from "~/lib/log";

/**
 * Enough markdown for what the agent actually emits: paragraphs, `**bold**`,
 * `` `code` `` and fenced blocks.
 *
 * It builds JSX nodes rather than assigning HTML, so agent output can never
 * become markup in this window.
 */

/**
 * A fenced block, or a run of prose. Splitting on the fence first is what makes
 * the difference: everything outside one is wrapped prose, and everything inside
 * one is text whose line breaks are the content.
 */
type Block = { kind: "code"; text: string; lang: string } | { kind: "prose"; text: string };

/**
 * Split a body into fenced blocks and the prose between them.
 *
 * Exported for its own test. An unterminated fence — an agent cut off
 * mid-block, which happens on a cancelled run — takes the rest of the body as
 * code rather than dropping it, because half a command shown as prose is worse
 * than half a command shown as a command.
 */
export function splitBlocks(body: string): Block[] {
  /*
   * Line by line rather than by regex. The obvious pattern for this wants `$`
   * to mean "end of the block", and with the `/m` flag it means "end of any
   * line" — so a lazy body closes at the first newline and every block comes
   * out one line long, which is precisely the newline loss this exists to fix.
   */
  const blocks: Block[] = [];
  let prose: string[] = [];
  let code: string[] | null = null;
  let lang = "";

  const flushProse = () => {
    const text = prose.join("\n");
    if (text.trim().length > 0) blocks.push({ kind: "prose", text });
    prose = [];
  };

  for (const line of body.split("\n")) {
    const fence = /^```(.*)$/.exec(line);
    if (!fence) {
      (code ?? prose).push(line);
      continue;
    }
    if (code === null) {
      flushProse();
      code = [];
      lang = fence[1].trim();
    } else {
      blocks.push({ kind: "code", text: code.join("\n"), lang });
      code = null;
      lang = "";
    }
  }

  // An unterminated fence keeps what was said as code — see the doc above.
  if (code === null) flushProse();
  else blocks.push({ kind: "code", text: code.join("\n"), lang });

  return blocks;
}

export function MessageBody(props: { body: string; class?: string }): JSX.Element {
  const blocks = () => splitBlocks(props.body);

  return (
    <div class={`flex flex-col gap-2.5 ${props.class ?? ""}`} data-selectable>
      <For each={blocks()}>
        {(block) =>
          block.kind === "code" ? (
            <CodeBlock text={block.text} lang={block.lang} />
          ) : (
            <For
              each={block.text
                .split(/\n{2,}/)
                // Trimmed, because the blank line that separated this prose
                // from a fence belongs to neither and would otherwise render as
                // a stray leading or trailing break.
                .map((part) => part.trim())
                .filter((part) => part.length > 0)}
            >
              {(paragraph) => <p>{renderInline(paragraph)}</p>}
            </For>
          )
        }
      </For>
    </div>
  );
}

/**
 * A fenced block: line breaks preserved, and copyable without a drag.
 *
 * The newlines are the whole point. Rendered as prose they collapse to spaces,
 * which turns a two-line path into one unusable line — the bug that made a
 * checkpoint path impossible to copy out of this window even when the selection
 * worked.
 *
 * The button exists because selecting inside a webview that sets
 * `user-select: none` on the body is fiddly at the best of times: a drag that
 * begins a pixel outside the text starts no selection at all, and the failure is
 * silent. A block of paths or commands is the thing people most want out of a
 * transcript, so it should not depend on landing the drag.
 */
function CodeBlock(props: { text: string; lang: string }): JSX.Element {
  const [copied, setCopied] = createSignal(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_400);
    } catch (cause) {
      log.warn(`could not copy the block: ${describeError(cause)}`);
    }
  };

  return (
    <div class="group relative">
      <pre
        data-selectable
        class="az-scroll overflow-x-auto rounded-lg border border-az-hairline bg-base-300 px-3 py-2.5 font-mono text-[12px] text-az-body leading-[1.6]"
      >
        <code>{props.text}</code>
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`Copy this ${props.lang || "code"} block`}
        title="Copy"
        class="absolute top-1.5 right-1.5 flex items-center gap-1 rounded-md border border-az-hairline-strong bg-base-200 px-1.5 py-[3px] text-[10.5px] text-az-faint opacity-0 transition-opacity hover:text-base-content focus:opacity-100 group-hover:opacity-100"
      >
        <Icon name={copied() ? "check" : "copy"} class="text-[11px]" />
        {copied() ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** Copy a whole message, for when the interesting part is not in one block. */
export function CopyMessageButton(props: { body: string }): JSX.Element {
  const [copied, setCopied] = createSignal(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard
          .writeText(props.body)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_400);
          })
          .catch((cause) => log.warn(`could not copy the message: ${describeError(cause)}`));
      }}
      aria-label="Copy this message"
      title="Copy the whole message"
      class="shrink-0 text-az-faint opacity-0 transition-opacity hover:text-base-content focus:opacity-100 group-hover:opacity-100"
    >
      <Show when={copied()} fallback={<Icon name="copy" class="text-[12px]" />}>
        <Icon name="check" class="text-[12px]" />
      </Show>
    </button>
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
