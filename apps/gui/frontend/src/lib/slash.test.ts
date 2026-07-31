import { describe, expect, it } from "vitest";
import { parseSlash } from "~/lib/slash";

const CONTEXT = { models: ["sonnet", "opus"], efforts: ["low", "high"] };

describe("parseSlash", () => {
  it("leaves prose alone", () => {
    expect(parseSlash("fix the picker", CONTEXT).kind).toBe("none");
    expect(parseSlash("", CONTEXT).kind).toBe("none");
  });

  /*
   * A pasted path opens with a slash and is not a command. `/usr/bin/env` going
   * to the agent as an error message instead of as text would be worse than any
   * command this feature adds.
   */
  it("treats a path as prose, not a command", () => {
    expect(parseSlash("/Users/revenge/code/agencyzero", CONTEXT).kind).toBe("none");
    expect(parseSlash("/etc/hosts is the file", CONTEXT).kind).toBe("none");
    expect(parseSlash("/", CONTEXT).kind).toBe("none");
  });

  it("switches the model, matching case-insensitively", () => {
    expect(parseSlash("/model opus", CONTEXT)).toEqual({ kind: "model", model: "opus" });
    expect(parseSlash("/MODEL Opus", CONTEXT)).toEqual({ kind: "model", model: "opus" });
  });

  it("names what is on offer when the argument is wrong", () => {
    const out = parseSlash("/model gpt-9", CONTEXT);
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("sonnet");
  });

  it("sets effort and permission", () => {
    expect(parseSlash("/effort high", CONTEXT)).toEqual({ kind: "effort", effort: "high" });
    expect(parseSlash("/permission edit", CONTEXT)).toEqual({
      kind: "permission",
      permission: "edit",
    });
  });

  /*
   * The point of the whole module. Sent as a prompt, `/compact` would be billed
   * as a turn in which the model read the word "compact" and guessed — a
   * failure that looks exactly like the feature not working.
   */
  it("refuses agent-session commands with the reason", () => {
    const out = parseSlash("/compact", CONTEXT);
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("agent-abstraction");
  });

  it("refuses an unknown command rather than sending it as text", () => {
    const out = parseSlash("/modle sonnet", CONTEXT);
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("/help");
  });

  it("lists what it knows", () => {
    const out = parseSlash("/help", CONTEXT);
    expect(out.kind).toBe("help");
    expect(out.kind === "help" && out.message).toContain("/model");
  });
});
