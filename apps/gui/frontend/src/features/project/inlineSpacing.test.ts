import { describe, expect, it } from "vitest";

import { softWrapToSpaces } from "./softWrap";

/**
 * A paragraph is delimited by a blank line, so a single newline inside one is a
 * wrap in the source rather than a break the author asked for.
 *
 * Between two plain words HTML collapses that newline to a space, which is why
 * this went unnoticed. Next to an inline element it does not: a text node
 * ending in `"and\n"` followed by `<code>` has its trailing whitespace dropped
 * at the element boundary, and the sentence renders as "and`Foo`now".
 */
describe("softWrapToSpaces", () => {
  it("keeps the space before an inline code span that a wrap would eat", () => {
    const wrapped = "Two changes: framing, and\n`WireMessage::Text` now takes\n`Utf8Bytes`.";
    expect(softWrapToSpaces(wrapped)).toBe(
      "Two changes: framing, and `WireMessage::Text` now takes `Utf8Bytes`.",
    );
  });

  it("leaves a paragraph that never wrapped alone", () => {
    const flat = "Needs the `compat` feature on tokio-util.";
    expect(softWrapToSpaces(flat)).toBe(flat);
  });

  it("does not collapse the spaces a line already had", () => {
    expect(softWrapToSpaces("a\nb c")).toBe("a b c");
  });
});
