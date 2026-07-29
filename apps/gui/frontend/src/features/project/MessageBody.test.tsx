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
