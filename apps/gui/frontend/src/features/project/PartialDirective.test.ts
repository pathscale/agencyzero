import { describe, expect, it } from "vitest";
import { holdBackPartialDirective } from "~/features/project/TranscriptPane";

/**
 * A direct last-line implementation, kept here as the oracle.
 *
 * The production implementation must remain bounded to the last line, because
 * it runs on every streaming token. This independently spells the intended
 * result at every prefix: an unfinished tail is hidden, as is a finished valid
 * authoring line until the next line starts.
 */
function unbounded(text: string): string {
  const lineStart = text.lastIndexOf("\n") + 1;
  const line = text.slice(lineStart);
  const inLine = line.lastIndexOf("<ps");
  if (inLine === -1) return text;
  const open = lineStart + inLine;
  const closed = text.indexOf(">", open);
  if (closed === -1) return text.slice(0, open);
  return /^\s*<ps @agency:[^\n]+>\s*$/.test(line) ? text.slice(0, lineStart) : text;
}

describe("holdBackPartialDirective", () => {
  it("matches an unbounded scan at every prefix", () => {
    const directive = '<ps @agency:items.state(id: "item-a3f9", status: "active")>';
    const bodies = [
      // No directive at all: the common case, and the one that used to be slow.
      "A perfectly ordinary reply.\n\nWith a second paragraph and no directives.",
      // A complete directive mid-body, then more prose after it.
      `Working on it.\n${directive}\nContinuing afterwards.`,
      // Two on one line: a closed one followed by a partial one. The partial is
      // what has to be held, which is why the search takes the *last* match.
      `Line with ${directive} and then <ps @agency:items.add(ref: "t1"`,
      // A directive on an earlier line and none on the last.
      `${directive}\n\nProse that follows on its own line.`,
      // A `<ps` that never closes, at the very end.
      'Trailing partial: <ps @agency:items.state(id: "item-',
      // A `>` before the `<ps`, so the forward search must start at the tag.
      "a > b and then <ps @agency:items",
      // No newline anywhere: the last line is the whole body.
      `One long single line ${directive} carrying on afterwards`,
    ];

    for (const body of bodies) {
      for (let at = 1; at <= body.length; at += 1) {
        const prefix = body.slice(0, at);
        expect(holdBackPartialDirective(prefix), `${JSON.stringify(body)} at ${at}`).toBe(
          unbounded(prefix),
        );
      }
    }
  });

  it("holds back both an arriving directive and its completed live tail", () => {
    const partial = 'Done.\n<ps @agency:items.state(id: "item-a3f9"';
    expect(holdBackPartialDirective(partial)).toBe("Done.\n");

    const complete = `${partial}, status: "active")>`;
    expect(holdBackPartialDirective(complete)).toBe("Done.\n");
    expect(holdBackPartialDirective(`${complete}\nContinuing.`)).toBe(`${complete}\nContinuing.`);
  });

  it("never exposes a complete Codex directive or private pong as the live tail", () => {
    expect(
      holdBackPartialDirective(
        '<ps @agency:items.add(ref: "t6", title: "Add wheel", priority: "high")>',
      ),
    ).toBe("");
    expect(holdBackPartialDirective("<ps @agency:pong()>")).toBe("");
  });
});
