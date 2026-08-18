import { fireEvent, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import {
  createStreamingSplitter,
  InlineText,
  MessageBody,
  splitBlocks,
} from "~/features/project/MessageBody";
import { setItemReferenceHandler } from "~/lib/itemReference";

describe("MessageBody", () => {
  it("splits on blank lines into paragraphs", () => {
    const { container } = render(() => <MessageBody body={"First para.\n\nSecond para."} />);
    const paragraphs = [...container.querySelectorAll("p")].map((p) => p.textContent);
    expect(paragraphs).toEqual(["First para.", "Second para."]);
  });

  it("gives each paragraph its own block", () => {
    // The precondition for bounding the streaming parse. Prose used to flush
    // only at a table or a list, so a reply with neither was one block holding
    // the entire message, and a parse whose only block is the whole message has
    // no prefix that can be cached. A paragraph closed by a blank line can
    // never change again, which is what makes the settled part identifiable.
    // This body would previously have been a single block.
    const blocks = splitBlocks("One.\n\nTwo.\n\nThree.");
    expect(blocks).toHaveLength(3);
    expect(blocks.map((block) => ("text" in block ? block.text : block.kind))).toEqual([
      "One.",
      "Two.",
      "Three.",
    ]);
  });

  it("parses a streaming reply exactly as a full reparse would, at every prefix", () => {
    // The incremental splitter is only worth having if it is indistinguishable
    // from splitBlocks, so compare them at every delta rather than at the end.
    // The bodies below are chosen for the cases that can break a settled
    // prefix: a fence spanning a blank line (prose settled early would become
    // code once the fence closes), a table, a list, and an unterminated fence.
    const bodies = [
      "One.\n\nTwo.\n\nThree.",
      "Intro.\n\n```rust\nlet a = 1;\n\nlet b = 2;\n```\n\nAfter the fence.",
      "Before.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter.",
      "Lead in.\n\n- one\n- two\n\nTrailing prose.",
      "Cut off mid stream.\n\n```sh\nnever closed",
      "\n\n\nleading blanks\n\n\n\ntrailing blanks\n\n",
    ];

    for (const body of bodies) {
      const split = createStreamingSplitter();
      for (let at = 1; at <= body.length; at += 1) {
        const prefix = body.slice(0, at);
        expect(split(prefix), `body ${JSON.stringify(body)} at ${at}`).toEqual(splitBlocks(prefix));
      }
    }
  });

  it("reparses from scratch when the body is not an extension of what it settled", () => {
    // One closure per message is the intent, but a reused one must not splice
    // the tail of a new reply onto the settled blocks of an old one.
    const split = createStreamingSplitter();
    split("First message.\n\nWith a settled paragraph.\n\nAnd a tail.");
    expect(split("A different message entirely.")).toEqual(
      splitBlocks("A different message entirely."),
    );
  });

  it("holds a finished paragraph still while the next one grows", () => {
    const [body, setBody] = createSignal("Settled paragraph.\n\nStill wri");
    const { container } = render(() => <MessageBody body={body()} />);
    const first = container.querySelectorAll("p")[0];

    setBody("Settled paragraph.\n\nStill writing now.");

    const after = container.querySelectorAll("p");
    expect(after[0]).toBe(first);
    expect(after[1]).toHaveTextContent("Still writing now.");
  });

  it("keeps a single newline inside one paragraph", () => {
    const { container } = render(() => <MessageBody body={"one\ntwo"} />);
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  it("renders newline-separated bullets as a real list", () => {
    const body = [
      "Release scope:",
      "",
      "- Split the Turn bar.",
      "- Add editable `Item context`.",
      "- Preserve handbacks.",
    ].join("\n");
    const { container } = render(() => <MessageBody body={body} />);

    expect(container.querySelectorAll("ul > li")).toHaveLength(3);
    expect([...container.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "Split the Turn bar.",
      "Add editable Item context.",
      "Preserve handbacks.",
    ]);
    expect(container.querySelector("li code")).toHaveTextContent("Item context");
  });

  it("renders numbered lines as an ordered list with their starting number", () => {
    const { container } = render(() => <MessageBody body={"3. Third\n4. Fourth"} />);
    const list = container.querySelector("ol");

    expect(list?.getAttribute("start")).toBe("3");
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
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

  it("turns a full item id into a compact in-app link", () => {
    const id = "item-ea97826a-9d9a-4e3e-879b-ae2660c8d789";
    let revealed = "";
    const removeHandler = setItemReferenceHandler((itemId) => {
      revealed = itemId;
    });
    const screen = render(() => <MessageBody body={`Resume ${id} next.`} />);

    const link = screen.getByRole("button", { name: `Open item ${id}` });
    expect(link).toHaveTextContent("Item-...ae2660c8d789");
    fireEvent.click(link);
    flush();
    expect(revealed).toBe(id);

    removeHandler();
  });

  it("keeps item ids inside code inert", () => {
    const id = "item-ea97826a-9d9a-4e3e-879b-ae2660c8d789";
    const screen = render(() => <MessageBody body={`Inspect \`${id}\`.`} />);
    expect(screen.queryByRole("button", { name: `Open item ${id}` })).not.toBeInTheDocument();
    expect(screen.container.querySelector("code")).toHaveTextContent(id);
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

/*
 * A markdown table the agent emits for benchmark numbers used to render as raw
 * pipes jammed into a paragraph. It is a table only when a delimiter row sits
 * under the header — a lone pipe line is prose, not a one-column table.
 */
describe("GFM tables", () => {
  const TABLE = [
    "| op | worktable | lmdb |",
    "|---|---|---|",
    "| insert | 1.94M | 1.32M |",
    "| range_scan | 13.5M | 23.6M |",
  ].join("\n");

  it("splits a table into a table block with header, rows and alignment", () => {
    const blocks = splitBlocks(TABLE);
    expect(blocks).toHaveLength(1);
    const [block] = blocks;
    expect(block.kind).toBe("table");
    if (block.kind !== "table") return;
    expect(block.header).toEqual(["op", "worktable", "lmdb"]);
    expect(block.rows).toEqual([
      ["insert", "1.94M", "1.32M"],
      ["range_scan", "13.5M", "23.6M"],
    ]);
    expect(block.align).toEqual([null, null, null]);
  });

  it("parses per-column alignment from the delimiter row", () => {
    const body = ["| a | b | c |", "| :--- | :--: | ---: |", "| 1 | 2 | 3 |"].join("\n");
    const [block] = splitBlocks(body);
    expect(block.kind).toBe("table");
    if (block.kind !== "table") return;
    expect(block.align).toEqual(["left", "center", "right"]);
  });

  it("separates surrounding prose from the table", () => {
    const body = `Before.\n\n${TABLE}\n\nAfter.`;
    const blocks = splitBlocks(body);
    expect(blocks.map((b) => b.kind)).toEqual(["prose", "table", "prose"]);
    // Prose text is untrimmed here — the render pass is what trims the blank
    // line that abutted the table — so match on the trimmed content.
    expect(blocks[0].kind).toBe("prose");
    expect(blocks[2].kind).toBe("prose");
    if (blocks[0].kind !== "prose" || blocks[2].kind !== "prose") return;
    expect(blocks[0].text.trim()).toBe("Before.");
    expect(blocks[2].text.trim()).toBe("After.");
  });

  it("leaves a single pipe line with no delimiter row as prose", () => {
    const blocks = splitBlocks("| op | worktable | lmdb |");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("prose");
  });

  it("leaves a pipe line inside a code fence as code", () => {
    const body = "```\n| op | worktable |\n|---|---|\n| insert | 1.94M |\n```";
    const blocks = splitBlocks(body);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("code");
    if (blocks[0].kind !== "code") return;
    expect(blocks[0].text).toContain("| insert | 1.94M |");
  });

  it("renders a table block as a real <table> with inline marks in cells", () => {
    const body = ["| metric | note |", "|---|---|", "| **p99** | see `--flag` |"].join("\n");
    const { container } = render(() => <MessageBody body={body} />);
    const table = container.querySelector("table");
    expect(table).toBeTruthy();
    expect([...container.querySelectorAll("th")].map((th) => th.textContent)).toEqual([
      "metric",
      "note",
    ]);
    expect(container.querySelector("td strong")).toHaveTextContent("p99");
    expect(container.querySelector("td code")).toHaveTextContent("--flag");
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
