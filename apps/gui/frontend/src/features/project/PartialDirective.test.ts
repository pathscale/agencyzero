import { describe, expect, it } from "vitest";
import { holdBackPartialDirective } from "~/features/project/TranscriptPane";

/**
 * The unbounded original, kept here as the oracle.
 *
 * `holdBackPartialDirective` now searches only the last line, because scanning
 * the whole body was O(body) on every streaming token and a miss — no directive
 * at all, which is most replies — was the case that had to reach the start of
 * the string before it could answer. The bound is only safe if it cannot change
 * an answer, so the two are compared at every prefix rather than at the end.
 */
function unbounded(text: string): string {
  const open = text.lastIndexOf("<ps");
  if (open === -1) return text;
  const closed = text.indexOf(">", open);
  return closed === -1 ? text.slice(0, open) : text;
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

  it("holds back a directive that is still arriving, and releases it when it closes", () => {
    const partial = 'Done.\n<ps @agency:items.state(id: "item-a3f9"';
    expect(holdBackPartialDirective(partial)).toBe("Done.\n");

    const complete = `${partial}, status: "active")>`;
    expect(holdBackPartialDirective(complete)).toBe(complete);
  });
});
