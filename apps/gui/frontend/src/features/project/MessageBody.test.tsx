import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { InlineText, MessageBody } from "~/features/project/MessageBody";

describe("MessageBody", () => {
  it("splits on blank lines into paragraphs", () => {
    const { container } = render(() => <MessageBody body={"First para.\n\nSecond para."} />);
    const paragraphs = [...container.querySelectorAll("p")].map((p) => p.textContent);
    expect(paragraphs).toEqual(["First para.", "Second para."]);
  });

  it("keeps a single newline inside one paragraph", () => {
    const { container } = render(() => <MessageBody body={"one\ntwo"} />);
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  it("renders **bold** as emphasis and leaves the delimiters out", () => {
    const { container } = render(() => <MessageBody body="**Phase A** ships as 0.9.3" />);
    const strong = container.querySelector("strong");
    expect(strong).toHaveTextContent("Phase A");
    expect(container.textContent).toBe("Phase A ships as 0.9.3");
  });

  it("renders `code` as code", () => {
    const { container } = render(() => <MessageBody body="the nits in `into_values`" />);
    expect(container.querySelector("code")).toHaveTextContent("into_values");
  });

  it("handles both marks in one line, in order", () => {
    const { container } = render(() => <MessageBody body="**B**: panic on `wait_for_ops()`" />);
    expect(container.querySelector("strong")).toHaveTextContent("B");
    expect(container.querySelector("code")).toHaveTextContent("wait_for_ops()");
    expect(container.textContent).toBe("B: panic on wait_for_ops()");
  });

  /*
   * Message.body is whatever the agent emitted. It is built into JSX nodes
   * rather than assigned as HTML precisely so it can never become markup in
   * this window, and that is worth pinning down rather than trusting.
   */
  it("never turns agent output into markup", () => {
    const hostile = '<img src=x onerror="alert(1)"> and <b>bold</b>';
    const { container } = render(() => <MessageBody body={hostile} />);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toBe(hostile);
  });

  it("drops blank blocks rather than rendering empty paragraphs", () => {
    const { container } = render(() => <MessageBody body={"a\n\n   \n\nb"} />);
    expect(container.querySelectorAll("p")).toHaveLength(2);
  });

  it("marks itself selectable, since the rest of the chrome is not", () => {
    const { container } = render(() => <MessageBody body="text" />);
    expect(container.querySelector("[data-selectable]")).toBeTruthy();
  });

  it("does not render a standalone Prompt Syntax authoring directive", () => {
    const directive = '<ps @agency:items.state(id: "item-869382d3", status: "active")>';
    const { container } = render(() => (
      <MessageBody body={`Working on it.\n${directive}\nContinuing.`} />
    ));

    expect(container.textContent).toBe("Working on it.Continuing.");
    expect(container.textContent).not.toContain(directive);
  });

  it("leaves misframed and quoted Prompt Syntax inert", () => {
    const directive = '<ps @agency:items.state(id: "item-a", status: "active")>';
    const body = `Attached to prose: ${directive}\n\n> ${directive}\n\n    ${directive}`;
    const { container } = render(() => <MessageBody body={body} />);

    expect(container.textContent).toContain(directive);
  });

  it("leaves undeclared Prompt Syntax namespaces inert", () => {
    const directive = "<ps @file:glossary.md>";
    const { container } = render(() => <MessageBody body={directive} />);

    expect(container.textContent).toContain(directive);
  });

  it("keeps malformed AgencyZero authoring visible", () => {
    const malformed = "<ps @agency:items.state(>";
    const { container } = render(() => <MessageBody body={malformed} />);

    expect(container.textContent).toContain(malformed);
  });
});

/*
 * Reported as "the chat area ate my ctrl+c copy" while lifting a checkpoint
 * path out of a reply. Two faults met there: nothing rendered a fenced block,
 * so the path's line breaks collapsed into spaces and what could be selected
 * was not the path — and `user-select: none` on the body meant a drag beginning
 * on the bubble's padding started no selection at all.
 */
describe("fenced blocks", () => {
  const PATH =
    "~/Library/Application Support/com.pathscale.agencyzero/db/checkpoints/\n  proj-6cf/300k.md";

  it("keeps the line breaks that make a path a path", () => {
    const { container } = render(() => <MessageBody body={`Here:\n\n\`\`\`\n${PATH}\n\`\`\``} />);
    const code = container.querySelector("pre code");

    expect(code).toBeTruthy();
    // Verbatim, newline included. Rendered as prose this became one line with a
    // space in the middle of the path, which is not a path.
    expect(code?.textContent).toBe(PATH);
  });

  it("does not show the fences as text", () => {
    const { container } = render(() => <MessageBody body={"```\nsome code\n```"} />);
    expect(container.textContent).not.toContain("```");
  });

  it("keeps the prose on both sides of a block", () => {
    const { container } = render(() => (
      <MessageBody body={"Before.\n\n```\ncode\n```\n\nAfter."} />
    ));
    const paragraphs = [...container.querySelectorAll("p")].map((p) => p.textContent);
    expect(paragraphs).toEqual(["Before.", "After."]);
    expect(container.querySelector("pre code")?.textContent).toBe("code");
  });

  /*
   * A cancelled run cuts the agent off mid-block. Half a command shown as a
   * command is honest; half a command reflowed into a sentence is not.
   */
  it("takes an unterminated fence as code rather than dropping it", () => {
    const { container } = render(() => <MessageBody body={"```sh\nrm -rf ./tmp\nand then"} />);
    expect(container.querySelector("pre code")?.textContent).toContain("rm -rf ./tmp");
  });

  it("offers a copy button, so lifting a path never depends on the drag", () => {
    const { getByLabelText } = render(() => <MessageBody body={"```sh\nls -la\n```"} />);
    expect(getByLabelText("Copy this sh block")).toBeTruthy();
  });

  it("is selectable even though the window is not", () => {
    const { container } = render(() => <MessageBody body={"```\ncode\n```"} />);
    expect(container.querySelector("pre[data-selectable]")).toBeTruthy();
  });

  /*
   * The reported bug, verbatim in shape: a fence indented under a numbered
   * step. Anchored at column 0 it was not a fence at all, so the block joined
   * the paragraph, its newlines collapsed, and the opening and closing
   * backticks paired as inline code with step 2 swallowed into the span. The
   * assertions below are each a symptom that was visible on screen.
   */
  it("reads a fence indented inside a list item", () => {
    const body = [
      "1. **Run it yourself**:",
      "",
      "   ```bash",
      "   cd ~/code/WorkTable",
      "   cargo publish -p worktable_codegen",
      "   ```",
      "",
      "2. **Restart me**, where the `ask` rule becomes a prompt.",
    ].join("\n");
    const { container } = render(() => <MessageBody body={body} />);

    const block = container.querySelector("pre code");
    expect(block?.textContent).toBe("cd ~/code/WorkTable\ncargo publish -p worktable_codegen");
    // Step 2 is prose, not the tail of a code span.
    expect(container.textContent).toContain("Restart me");
    expect(container.textContent).not.toContain("**Restart me**");
    // And its own inline code still reads as code.
    expect([...container.querySelectorAll("code")].map((c) => c.textContent)).toContain("ask");
  });

  it("keeps Prompt Syntax inert inside either Markdown fence marker", () => {
    const directive = '<ps @agency:items.retire(id: "item-a")>';
    const body = `\`\`\`\`text\n${directive}\n\`\`\`\n\`\`\`\`\n~~~~\n${directive}\n~~~~`;
    const { container } = render(() => <MessageBody body={body} />);

    expect(container.querySelector("[data-ps-directive]")).toBeNull();
    expect([...container.querySelectorAll("pre code")].map((node) => node.textContent)).toEqual([
      `${directive}\n\`\`\``,
      directive,
    ]);
  });
});

describe("InlineText", () => {
  it("applies the same marks to a single run of text", () => {
    const { container } = render(() => (
      <InlineText text="Stopped `rm -rf ./snapshots/tmp` — outside the working directories" />
    ));

    expect(container.querySelector("code")).toHaveTextContent("rm -rf ./snapshots/tmp");
    expect(container.textContent).toBe(
      "Stopped rm -rf ./snapshots/tmp — outside the working directories",
    );
  });

  it("passes plain prose through untouched", () => {
    const { container } = render(() => <InlineText text="no marks here" />);
    expect(container.textContent).toBe("no marks here");
    expect(container.querySelector("code")).toBeNull();
  });
});
