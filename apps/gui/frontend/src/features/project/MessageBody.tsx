import { PromptSyntaxParser } from "promptsyntax";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { Button } from "~/components/Button";
import { Icon } from "~/components/Icon";
import { isItemId, itemReferenceLabel, revealItemReference } from "~/lib/itemReference";
import { describeError, log } from "~/lib/log";
import { tx } from "~/stores/i18n";

/**
 * Put text on the clipboard, by whichever route works here.
 *
 * `navigator.clipboard` is the right API and is not always available: it needs
 * a secure context and a permission the webview may not grant, and when it is
 * refused it rejects rather than degrading. That left the copy buttons doing
 * nothing but writing a line to the log.
 *
 * `execCommand("copy")` is deprecated and works everywhere, including here. It
 * needs a real selection, so it borrows one from an off-screen textarea and
 * puts back whatever the user had selected — otherwise clicking Copy would
 * clear the selection they were about to copy by hand.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (cause) {
    log.warn(`the clipboard API refused, falling back: ${describeError(cause)}`);
  }

  const holder = document.createElement("textarea");
  holder.value = text;
  // Off-screen rather than hidden: `display:none` cannot be selected, and the
  // selection is what `execCommand` copies.
  holder.setAttribute("readonly", "");
  holder.style.position = "fixed";
  holder.style.top = "-1000px";
  holder.style.opacity = "0";
  document.body.appendChild(holder);

  const previous = document.getSelection()?.rangeCount
    ? document.getSelection()?.getRangeAt(0)
    : null;
  holder.select();

  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (cause) {
    log.error(`could not copy: ${describeError(cause)}`);
  }

  holder.remove();
  if (previous) {
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(previous);
  }
  return ok;
}

/**
 * Read the clipboard, by whichever route works here.
 *
 * The mirror of {@link copyText}, and it exists for the same reason that one
 * does: the renderer that ships is Blitz, not WebKit, and it dispatches no
 * `paste` event to JS at all. Blitz answers ⌘V itself, but only for a focused
 * native text input (`blitz-dom`'s `text.rs`), so a paste aimed at anything
 * else reached no handler in either language and did nothing at all.
 *
 * `execCommand("paste")` is deliberately not a fallback. It is refused for
 * scripted callers everywhere for the obvious reason — a page that can read the
 * clipboard unprompted can read your password manager — so there is nothing to
 * fall back *to*. A refusal here is the real answer, and the caller leaves the
 * field alone rather than clearing it.
 */
export async function pasteText(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch (cause) {
    log.warn(`the clipboard could not be read: ${describeError(cause)}`);
    return null;
  }
}

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
type Block =
  | { kind: "code"; text: string; lang: string }
  | { kind: "prose"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | {
      kind: "table";
      header: string[];
      rows: string[][];
      align: ("left" | "center" | "right" | null)[];
    };

const promptSyntax = new PromptSyntaxParser({ authoringNamespaces: ["agency"] });

/** The same explicit authoring-line boundary Rust promotes. */
export function isPromptSyntaxDirectiveLine(line: string): boolean {
  if (line.startsWith("    ") || line.startsWith("\t")) return false;
  const trimmed = line.trim();
  if (trimmed.startsWith(">")) return false;
  const parsed = promptSyntax.parse(trimmed);
  if (parsed.segments.length !== 1) return false;
  const [segment] = parsed.segments;
  return (
    segment?.type === "directive" &&
    segment.span.start === 0 &&
    segment.span.end === trimmed.length &&
    segment.directive.kind === "authoring_segment"
  );
}

/**
 * Split a `| a | b |` row into its cells.
 *
 * The pipe that separates cells is a bare `|`; a `\|` is a literal pipe inside a
 * cell, so it does not split. The `| a | b |` style wraps the row in leading and
 * trailing pipes — those produce empty edge cells that are not columns, so they
 * are dropped.
 */
function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") {
      cell += "|";
      i += 1;
    } else if (ch === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  if (cells[0] === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

/** A row that is only pipes and dashes with optional `:` markers is a delimiter. */
function tableAlignments(cells: string[]): ("left" | "center" | "right" | null)[] | null {
  if (cells.length === 0) return null;
  const align: ("left" | "center" | "right" | null)[] = [];
  for (const cell of cells) {
    if (!/^:?-{1,}:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    align.push(left && right ? "center" : right ? "right" : left ? "left" : null);
  }
  return align;
}

/**
 * Pull GFM tables out of a run of prose, in order, as their own blocks.
 *
 * A table is a header row of `| ... |` cells immediately followed by a
 * delimiter row (`|---|:--:|`); the delimiter is what tells a table apart from a
 * lone line that happens to hold a pipe, so a header with no delimiter under it
 * stays prose. Everything that is not a table falls back to a prose block, which
 * keeps the paragraph-splitting downstream exactly as it was.
 */
function extractProseStructures(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let prose: string[] = [];

  const flush = () => {
    const joined = prose.join("\n");
    if (joined.trim().length > 0) blocks.push({ kind: "prose", text: joined });
    prose = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const next = lines[i + 1];
    if (line.includes("|") && next?.includes("|")) {
      const align = tableAlignments(splitTableRow(next));
      if (align) {
        const header = splitTableRow(line);
        const rows: string[][] = [];
        let j = i + 2;
        while (j < lines.length && lines[j].includes("|") && lines[j].trim().length > 0) {
          rows.push(splitTableRow(lines[j]));
          j += 1;
        }
        flush();
        blocks.push({ kind: "table", header, rows, align });
        i = j - 1;
        continue;
      }
    }

    // A blank line ends a paragraph, and a paragraph is a block.
    //
    // Prose used to flush only at a table or a list, so a reply with neither —
    // most replies — was a single block holding the whole message.
    //
    // Be precise about what this buys, because it is less than it looks. It
    // does *not* make the per-token cost sublinear on its own: `splitBlocks`
    // still walks the entire body on every token, and so do the `sameBlock`
    // comparisons. The DOM write was already bounded, by the `<For>` over
    // `/\n{2,}/` further down, which diffs paragraphs by value.
    //
    // What it buys is the precondition for bounding the parse: a paragraph
    // closed by a blank line can never change again, so everything before the
    // last blank line is settled and re-parsing it is provably wasted work.
    // Nothing can cache a prefix of a parse whose only block is the whole
    // message.
    //
    // The rendered output is unchanged. A prose block is already split into one
    // `<p>` per paragraph below, and `<For>` adds no wrapper, so those
    // paragraphs were already direct children of the same flex container.
    if (line.trim().length === 0) {
      flush();
      continue;
    }

    const firstItem = /^\s*(?:(\d+)[.)]|[-*+])\s+(.+)$/.exec(line);
    if (firstItem) {
      flush();
      const ordered = firstItem[1] !== undefined;
      const start = ordered ? Number(firstItem[1]) : 1;
      const items = [firstItem[2]];
      let j = i + 1;
      while (j < lines.length) {
        const item = /^\s*(?:(\d+)[.)]|[-*+])\s+(.+)$/.exec(lines[j]);
        if (!item || (item[1] !== undefined) !== ordered) break;
        items.push(item[2]);
        j += 1;
      }
      blocks.push({ kind: "list", ordered, start, items });
      i = j - 1;
      continue;
    }
    prose.push(line);
  }

  flush();
  return blocks;
}

/**
 * Split a body into fenced blocks and the prose between them.
 *
 * Exported for its own test. An unterminated fence — an agent cut off
 * mid-block, which happens on a cancelled run — takes the rest of the body as
 * code rather than dropping it, because half a command shown as prose is worse
 * than half a command shown as a command.
 */
/** Whether a re-parsed block is unchanged, so its DOM can be left alone. */
function sameBlock(a: Block, b: Block): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "code" && b.kind === "code") {
    return a.text === b.text && a.lang === b.lang;
  }
  if (a.kind === "table" && b.kind === "table") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return "text" in a && "text" in b ? a.text === b.text : false;
}

export function splitBlocks(body: string): Block[] {
  return parseBlocks(body).blocks;
}

/**
 * As [`splitBlocks`], and also whether the body ended with a fence still open.
 *
 * The streaming splitter needs that second answer: a prefix is only safe to
 * treat as final if no fence spans its end, since a fence opened before the
 * boundary and closed after it turns prose into code retroactively.
 */
function parseBlocks(body: string): { blocks: Block[]; openFence: boolean } {
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
  let indent = "";
  let marker = "";

  const flushProse = () => {
    const text = prose.join("\n");
    // Tables live only outside fences, so this prose path is where they surface.
    if (text.trim().length > 0) blocks.push(...extractProseStructures(text));
    prose = [];
  };

  /*
   * A fence inside a list item is indented to sit under it, which is how
   * anyone writes "step 1, then run this". Anchoring the fence at column 0
   * missed those: the block fell through to prose, its newlines collapsed into
   * the paragraph, and the two fences then paired off as inline code with the
   * step after them swallowed into the span. The block is de-indented by
   * however far its opening fence was, so the code reads as written.
   */
  const deindent = (line: string) => {
    let cut = 0;
    while (cut < indent.length && (line[cut] === " " || line[cut] === "\t")) cut += 1;
    return line.slice(cut);
  };

  for (const line of body.split("\n")) {
    const fence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) {
      if (code !== null) {
        code.push(deindent(line));
      } else if (isPromptSyntaxDirectiveLine(line)) {
        flushProse();
      } else {
        prose.push(line);
      }
      continue;
    }
    if (code === null) {
      flushProse();
      code = [];
      indent = fence[1];
      marker = fence[2];
      lang = fence[3].trim();
    } else if (
      fence[2][0] === marker[0] &&
      fence[2].length >= marker.length &&
      fence[3].trim().length === 0
    ) {
      blocks.push({ kind: "code", text: code.join("\n"), lang });
      code = null;
      lang = "";
      indent = "";
      marker = "";
    } else {
      code.push(deindent(line));
    }
  }

  // An unterminated fence keeps what was said as code — see the doc above.
  if (code === null) flushProse();
  else blocks.push({ kind: "code", text: code.join("\n"), lang });

  return { blocks, openFence: code !== null };
}

/** How much of the settled prefix is re-checked before it is trusted. */
const BOUNDARY_SAMPLE = 32;

/**
 * A `splitBlocks` that only parses what has changed.
 *
 * `MessageBody` re-parsed `props.body` on every token, and `splitBlocks` splits
 * the whole body into lines however few blocks come out, so a reply arriving in
 * 4-character deltas paid for its entire length on every delta. Measured with
 * `streamingParse.bench.ts`: 40.5ms at 5,000 characters and 2,400.8ms at
 * 40,000, a factor of about 4 for every doubling. Textbook quadratic.
 *
 * A paragraph closed by a blank line can never change again, so everything up
 * to the last blank line is final and re-parsing it is provably wasted. This
 * keeps those blocks and parses only the tail after them. Each character is
 * parsed into a settled block exactly once, so the amortised cost per token is
 * the length of the tail rather than the length of the reply.
 *
 * Two things it does not claim to be. Blocks are still concatenated per token,
 * which is O(number of blocks) and therefore still quadratic in paragraph
 * count — 166 paragraphs against 12,500 tokens is about 2 million operations,
 * against the 312 million characters this removes, so it is left alone until it
 * shows up in a measurement. And a fence open across the boundary blocks the
 * advance entirely, because a fence closed later turns settled prose into code
 * retroactively; a reply that is one long unterminated fence gets no benefit,
 * correctly.
 */
export function createStreamingSplitter(): (body: string) => Block[] {
  let settledChars = 0;
  let settledBlocks: Block[] = [];
  let boundary = "";

  return (body: string): Block[] => {
    /*
     * Validate the prefix before trusting it, but in constant time.
     *
     * Comparing the whole settled prefix would reintroduce exactly the O(body)
     * per token this exists to remove. Streaming is append-only, so the cases
     * worth catching are a shorter body and a different message reusing this
     * closure; a length check and the characters immediately before the
     * boundary catch both. A miss costs correctness, so the fallback is a full
     * reparse rather than a partial one.
     */
    const stale =
      settledChars > body.length ||
      (settledChars > 0 &&
        body.slice(Math.max(0, settledChars - BOUNDARY_SAMPLE), settledChars) !== boundary);
    if (stale) {
      settledChars = 0;
      settledBlocks = [];
      boundary = "";
    }

    const tail = body.slice(settledChars);
    const parsed = parseBlocks(tail);
    const blocks = settledChars === 0 ? parsed.blocks : [...settledBlocks, ...parsed.blocks];

    // Advance the boundary to just past the last blank line in the tail. The
    // text before it is parsed once, here, and never looked at again.
    const lastBreak = tail.lastIndexOf("\n\n");
    if (lastBreak > 0) {
      const candidate = tail.slice(0, lastBreak + 2);
      const settledParse = parseBlocks(candidate);
      if (!settledParse.openFence) {
        settledBlocks =
          settledChars === 0 ? settledParse.blocks : [...settledBlocks, ...settledParse.blocks];
        settledChars += candidate.length;
        boundary = body.slice(Math.max(0, settledChars - BOUNDARY_SAMPLE), settledChars);
      }
    }

    return blocks;
  };
}

export function MessageBody(props: { body: string; class?: string }): JSX.Element {
  /*
   * Memoised, and identity-stable block by block.
   *
   * This was a plain function, so it re-parsed the whole body on every read and
   * handed `<For>` brand-new objects each time. A streaming reply changes
   * `body` on every token, so every token re-parsed the entire message and
   * rebuilt every block, including the ones that had not changed. That is
   * quadratic in reply length and it is what made long replies crawl.
   *
   * Only the final block grows while text streams, so reusing the earlier
   * blocks keeps their DOM alive and leaves one block to update.
   */
  let previous: Block[] = [];
  const split = createStreamingSplitter();
  const blocks = createMemo(() => {
    const next = split(props.body);
    const reconciled = next.map((block, index) => {
      const before = previous[index];
      // Identity first. A settled block is handed back as the same object every
      // token, so this short-circuits the text comparison for the whole prefix
      // rather than comparing every paragraph against itself.
      if (before === block) return before;
      return before && sameBlock(before, block) ? before : block;
    });
    previous = reconciled;
    return reconciled;
  });

  return (
    /*
      `min-w-0` and `break-words`: a flex child will not shrink below its
      content width without the first, and an unbroken run of characters (a
      long identifier, a url, a wall of one repeated letter) has no break
      opportunity without the second. Between them, message text stayed at its
      natural width and drew straight past the edge of its own bubble.
    */
    <div
      class={`flex min-w-0 flex-col gap-2.5 break-words [overflow-wrap:anywhere] ${props.class ?? ""}`}
      data-selectable
    >
      <For each={blocks()}>
        {(block) =>
          block.kind === "code" ? (
            <CodeBlock text={block.text} lang={block.lang} />
          ) : block.kind === "table" ? (
            <TableBlock header={block.header} rows={block.rows} align={block.align} />
          ) : block.kind === "list" ? (
            <Show
              when={block.ordered}
              fallback={
                <ul class="list-outside list-disc space-y-1 pl-5">
                  <For each={block.items}>{(item) => <li>{renderInline(item)}</li>}</For>
                </ul>
              }
            >
              <ol start={block.start} class="list-outside list-decimal space-y-1 pl-5">
                <For each={block.items}>{(item) => <li>{renderInline(item)}</li>}</For>
              </ol>
            </Show>
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
    if (!(await copyText(props.text))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_400);
  };

  return (
    <div class="group relative">
      <pre
        data-selectable
        class="az-scroll overflow-x-auto rounded-lg border border-az-hairline bg-base-300 px-3 py-2.5 font-mono text-[12px] text-az-body leading-[1.6]"
      >
        <code>{props.text}</code>
      </pre>
      <Button
        type="button"
        onClick={() => void copy()}
        aria-label={tx("Copy this {language} block", { language: props.lang || tx("code") })}
        title={tx("Copy")}
        class="absolute top-1.5 right-1.5 flex items-center gap-1 rounded-md border border-az-hairline-strong bg-base-200 px-1.5 py-[3px] text-[10.5px] text-az-faint transition-colors hover:text-base-content"
      >
        <Icon name={copied() ? "check" : "copy"} class="text-[11px]" />
        {copied() ? tx("Copied") : tx("Copy")}
      </Button>
    </div>
  );
}

/**
 * A GFM table: the pipe grid the agent emits for benchmark numbers, rendered as
 * a real table rather than the raw pipes jammed into a paragraph. Wide ones
 * scroll sideways the way a fenced block does, so a many-column table never
 * squeezes the column past legibility.
 */
function TableBlock(props: {
  header: string[];
  rows: string[][];
  align: ("left" | "center" | "right" | null)[];
}): JSX.Element {
  const alignClass = (col: number): string => {
    const at = props.align[col];
    return at === "center" ? "text-center" : at === "right" ? "text-right" : "text-left";
  };

  return (
    <div data-selectable class="az-scroll overflow-x-auto rounded-lg border border-az-hairline">
      <table class="w-full border-collapse text-[12px] text-az-body">
        <thead>
          <tr>
            <For each={props.header}>
              {(cell, col) => (
                <th
                  class={`border-az-hairline border-b bg-base-300 px-3 py-1.5 font-semibold text-az-strong ${alignClass(col())}`}
                >
                  {renderInline(cell)}
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {(row) => (
              <tr>
                <For each={props.header}>
                  {(_, col) => (
                    <td class={`border-az-hairline border-b px-3 py-1.5 ${alignClass(col())}`}>
                      {renderInline(row[col()] ?? "")}
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

/** Copy a whole message, for when the interesting part is not in one block. */
export function CopyMessageButton(props: { body: string }): JSX.Element {
  const [copied, setCopied] = createSignal(false);

  return (
    <Button
      type="button"
      onClick={() => {
        void copyText(props.body).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_400);
        });
      }}
      aria-label={tx("Copy this message")}
      title={tx("Copy the whole message")}
      class="shrink-0 text-az-faint transition-colors hover:text-base-content"
    >
      <Show when={copied()} fallback={<Icon name="copy" class="text-[12px]" />}>
        <Icon name="check" class="text-[12px]" />
      </Show>
    </Button>
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
const ITEM_REFERENCE_SPLIT =
  /(item-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

function renderItemReferences(text: string): JSX.Element {
  return text
    .split(ITEM_REFERENCE_SPLIT)
    .filter(Boolean)
    .map((part) =>
      isItemId(part) ? (
        <Button
          type="button"
          class="inline cursor-pointer font-medium text-az-link underline decoration-az-link/45 decoration-dotted underline-offset-2 hover:text-primary"
          title={part}
          aria-label={`Open item ${part}`}
          onClick={() => revealItemReference(part)}
        >
          {itemReferenceLabel(part)}
        </Button>
      ) : (
        part
      ),
    );
}

function renderInline(text: string): JSX.Element[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);

  return parts.filter(Boolean).map((part) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong class="font-semibold text-az-strong">
          {renderItemReferences(part.slice(2, -2))}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <InlineCode>{part.slice(1, -1)}</InlineCode>;
    }
    return <>{renderItemReferences(part)}</>;
  });
}

export function InlineCode(props: { children: JSX.Element }): JSX.Element {
  return (
    <code class="rounded-[5px] border border-az-hairline bg-base-300 px-[5px] py-px font-mono text-[12px] text-info">
      {props.children}
    </code>
  );
}
