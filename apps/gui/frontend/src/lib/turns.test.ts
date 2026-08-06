import { describe, expect, it } from "vitest";
import { agentTurnLabels } from "~/lib/turns";
import type { Message, MessageAuthor } from "~/types";

function message(id: string, author: MessageAuthor, stop = "completed"): Message {
  return {
    id,
    projectId: "project-a",
    itemId: null,
    author,
    agent: "codex",
    moderation: null,
    model: "gpt-5.6-sol",
    permission: "auto",
    usage: null,
    stop,
    exitCode: 0,
    body: id,
    createdAt: "2026-08-07T00:00:00Z",
  };
}

describe("agent turn labels", () => {
  it("numbers ordinary replies without a chunk suffix", () => {
    const labels = agentTurnLabels([
      message("user-1", "user"),
      message("agent-1", "agent"),
      message("user-2", "user"),
      message("agent-2", "agent"),
    ]);
    expect(labels).toEqual({ "agent-1": "1", "agent-2": "2" });
  });

  it("keeps interleaved follow-ups in one turn and numbers its chunks", () => {
    const labels = agentTurnLabels([
      message("user-open", "user"),
      message("agent-first", "agent", "continued"),
      message("user-follow-up", "user"),
      message("agent-second", "agent", "continued"),
      message("user-last", "user"),
      message("agent-final", "agent"),
      message("user-next", "user"),
      message("agent-next", "agent"),
    ]);
    expect(labels).toEqual({
      "agent-first": "1.1",
      "agent-second": "1.2",
      "agent-final": "1.3",
      "agent-next": "2",
    });
  });

  it("labels a lone interrupted chunk as the first part of its turn", () => {
    const labels = agentTurnLabels([
      message("user-open", "user"),
      message("agent-first", "agent", "continued"),
    ]);
    expect(labels).toEqual({ "agent-first": "1.1" });
  });
});
