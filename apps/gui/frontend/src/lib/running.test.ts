import { describe, expect, it } from "vitest";
import { LIVE_TURN_ID, runningRows } from "~/lib/running";
import type { RunningTask } from "~/types";

const tool = (id: string): RunningTask => ({
  toolCallId: id,
  projectId: "grow",
  itemId: null,
  name: "list_dir",
  label: "/tmp",
  startedAt: "2026-09-14T12:00:00.000Z",
  isCancelable: true,
});

const turn = {
  agent: "grok" as const,
  activity: "thinking…",
  startedAt: Date.parse("2026-09-14T12:00:10.000Z"),
};

describe("runningRows", () => {
  it("lists in-flight tools and ignores the live turn while they are open", () => {
    const rows = runningRows("grow", [tool("a"), tool("b")], turn);
    expect(rows.map((row) => row.toolCallId)).toEqual(["a", "b"]);
  });

  it("keeps Claude and Codex tool rows; the turn fallback does not replace them", () => {
    const bash: RunningTask = {
      toolCallId: "tc-bash",
      projectId: "worktable",
      itemId: "worktable-0",
      name: "Bash",
      label: "cargo test -p az-core",
      startedAt: "2026-09-14T12:00:00.000Z",
      isCancelable: true,
    };
    const claudeTurn = {
      agent: "claude" as const,
      activity: "running Bash…",
      startedAt: Date.parse("2026-09-14T12:00:00.000Z"),
    };
    expect(runningRows("worktable", [bash], claudeTurn)).toEqual([bash]);
  });

  it("shows the live turn when a run is accepted and no tool is in flight", () => {
    const rows = runningRows("grow", [], turn);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      toolCallId: LIVE_TURN_ID,
      projectId: "grow",
      name: "grok",
      label: "thinking…",
      isCancelable: true,
    });
    expect(rows[0].startedAt).toBe("2026-09-14T12:00:10.000Z");
  });

  it("treats a missing tool list the same as an empty one", () => {
    expect(runningRows("grow", undefined, turn)).toHaveLength(1);
  });

  it("is empty when nothing is running", () => {
    expect(runningRows("grow", [], undefined)).toEqual([]);
    expect(runningRows("grow", undefined, undefined)).toEqual([]);
  });
});
