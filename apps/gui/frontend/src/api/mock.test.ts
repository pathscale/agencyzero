import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgencyZeroApi } from "~/api/client";
import { createMockApi } from "~/api/mock";
import type { Message, Project, ProjectItem, TaskLogEntry } from "~/types";

let api: AgencyZeroApi;

beforeEach(() => {
  api = createMockApi();
});

describe("projects", () => {
  it("serves the design fixtures in manual order", async () => {
    const projects = await api.listProjects();
    expect(projects.map((project) => project.name)).toEqual([
      "WorkTable",
      "api.support.cafe",
      "agencyzero",
    ]);
  });

  it("hands back an independent copy, so a caller cannot mutate the backend", async () => {
    const first = await api.listProjects();
    first[0].name = "clobbered";
    const second = await api.listProjects();
    expect(second[0].name).toBe("WorkTable");
  });

  it("broadcasts a creation, and records the first message as the user's", async () => {
    const created = vi.fn();
    const appended = vi.fn();
    await api.on("project:created", created);
    await api.on("message:appended", appended);

    const { project } = await api.createProject({ firstMessage: "Port the emitter\nsecond line" });

    expect(project.name).toBe("Port the emitter");
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ id: project.id }));
    expect(appended).toHaveBeenCalledWith(
      expect.objectContaining({ author: "user", body: "Port the emitter\nsecond line" }),
    );
  });

  it("reorders by the ids it is given and broadcasts each move", async () => {
    const updated = vi.fn();
    await api.on("project:updated", updated);

    const reordered = await api.reorderProjects(["agencyzero", "worktable", "cafe"]);

    expect(reordered.map((project: Project) => project.id)).toEqual([
      "agencyzero",
      "worktable",
      "cafe",
    ]);
    expect(updated).toHaveBeenCalledTimes(3);
  });

  it("takes a directory and gives it back, without duplicating an existing one", async () => {
    await api.addDir("worktable", "~/src/new");
    await api.addDir("worktable", "~/src/new");
    const [worktable] = await api.listProjects();
    expect(worktable.dirs.filter((dir) => dir === "~/src/new")).toHaveLength(1);

    const removed = await api.removeDir("worktable", "~/src/new");
    expect(removed.dirs).not.toContain("~/src/new");
  });

  it("forks into a new project that shares history up to the message", async () => {
    const fork = await api.forkProject("worktable", "wt-2");

    expect(fork.id).not.toBe("worktable");
    expect(fork.forkedFrom).toEqual({ projectId: "worktable", messageId: "wt-2" });

    const carried = await api.listMessages(fork.id);
    expect(carried.map((message: Message) => message.body)).toEqual([
      expect.stringContaining("Review the WorkTable upgrade"),
      expect.stringContaining("Phase A"),
    ]);
  });
});

describe("items", () => {
  it("creates at the end of its project and broadcasts", async () => {
    const created = vi.fn();
    await api.on("item:created", created);

    const item = await api.createItem("worktable", "Write the tests");

    expect(item).toMatchObject({
      projectId: "worktable",
      title: "Write the tests",
      status: "pending",
      order: 5,
    });
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ id: item.id }));
  });

  it("deletes and says which project lost it", async () => {
    const deleted = vi.fn();
    await api.on("item:deleted", deleted);

    await api.deleteItem("worktable-1");

    expect(deleted).toHaveBeenCalledWith({ id: "worktable-1", projectId: "worktable" });
    const remaining = await api.listItems("worktable");
    expect(remaining.map((item: ProjectItem) => item.id)).not.toContain("worktable-1");
  });
});

describe("moderation", () => {
  it("clears the hold on approval, so the run is no longer waiting", async () => {
    const before = await api.listMessages("cafe");
    const hold = before.find((message) => message.moderation?.needsApproval);
    expect(hold?.moderation?.severity).toBe("critical");

    const resolved = await api.resolveModeration(hold!.id, true);

    expect(resolved.moderation).toMatchObject({ needsApproval: false, verdict: "flagged" });
  });

  it("denying also releases the hold, but does not mark it as having run", async () => {
    const [hold] = (await api.listMessages("cafe")).filter((m) => m.moderation?.needsApproval);
    const resolved = await api.resolveModeration(hold.id, false);
    expect(resolved.moderation).toMatchObject({ needsApproval: false, verdict: "noted" });
  });
});

describe("tasks", () => {
  it("moves a cancelled task out of Running and into the log", async () => {
    const finished = vi.fn();
    await api.on("task:finished", finished);

    await api.cancelTask("tc-wt-test");

    const running = await api.listRunningTasks("worktable");
    expect(running.map((task) => task.toolCallId)).not.toContain("tc-wt-test");
    expect(finished).toHaveBeenCalledWith(
      expect.objectContaining({ label: "cargo test -p az-core", ok: false }),
    );
  });

  it("cancelling the run empties Running for that project only", async () => {
    const stopped = vi.fn();
    await api.on("run:stopped", stopped);

    await api.cancelRun("worktable");

    expect(await api.listRunningTasks("worktable")).toHaveLength(0);
    expect(await api.listRunningTasks("cafe")).toHaveLength(1);
    expect(stopped).toHaveBeenCalledWith(expect.objectContaining({ projectId: "worktable" }));
  });

  /*
   * The panel badge shows the whole log while the panel holds one page, so the
   * total has to travel with the page rather than be inferred from its length.
   */
  it("reports a total larger than the page it returns", async () => {
    const page = await api.listTaskLog("worktable", 2);
    expect(page.entries).toHaveLength(2);
    expect(page.total).toBe(91);
  });

  it("returns the log newest first and pages with a cursor", async () => {
    const all = await api.listTaskLog("worktable", 10);
    const sorted = [...all.entries].sort((a: TaskLogEntry, b: TaskLogEntry) =>
      b.finishedAt.localeCompare(a.finishedAt),
    );
    expect(all.entries).toEqual(sorted);

    const older = await api.listTaskLog("worktable", 10, all.entries[0].finishedAt);
    expect(older.entries.every((entry) => entry.finishedAt < all.entries[0].finishedAt)).toBe(true);
  });

  it("clearing zeroes the total as well as the rows", async () => {
    await api.clearTaskLog("worktable");
    const page = await api.listTaskLog("worktable", 10);
    expect(page).toEqual({ entries: [], total: 0 });
  });
});

describe("settings", () => {
  it("merges a leaf patch without flattening its siblings", async () => {
    const before = await api.getSettings();
    expect(before.moderator).toMatchObject({ enabled: true, confineToDirs: true });

    const after = await api.setSettings({ moderator: { model: "opus" } });

    expect(after.moderator).toMatchObject({
      model: "opus",
      enabled: true,
      confineToDirs: true,
      onCritical: "cancel_run",
    });
    expect(after.defaultPermission).toBe("read_only");
  });

  it("re-probing stamps a fresh checkedAt", async () => {
    const before = await api.listAgentStatus(false);
    const after = await api.listAgentStatus(true);
    expect(Date.parse(after[0].checkedAt)).toBeGreaterThanOrEqual(Date.parse(before[0].checkedAt));
  });

  it("keeps study collection off until an explicit transition", async () => {
    const before = await api.getStudySummary();
    expect(before).toMatchObject({ enabled: false, eventCount: 0, studyId: null });

    const settings = await api.setSettings({ studyAnalytics: { enabled: true } });
    const started = await api.getStudySummary();

    expect(settings.studyAnalytics.sessionId).toMatch(/^study-/);
    expect(started).toMatchObject({ enabled: true, eventCount: 1 });
  });

  it("deletes study rows without silently changing consent", async () => {
    await api.setSettings({ studyAnalytics: { enabled: true } });
    await api.setSettings({ studyAnalytics: { enabled: false } });
    await api.clearStudyEvents();

    expect(await api.getStudySummary()).toMatchObject({ enabled: false, eventCount: 0 });
  });
});

describe("rate limits", () => {
  /*
   * `run:rate_limit` announces a change; a window opened after one arrived
   * still has to learn about it, which is what this command is for.
   */
  it("reports limits already in force", async () => {
    const limits = await api.listRateLimits();
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({ projectId: "cafe", message: "Rate limited" });
  });
});

describe("events", () => {
  it("stops delivering once unsubscribed", async () => {
    const handler = vi.fn();
    const unlisten = await api.on("item:created", handler);

    await api.createItem("worktable", "one");
    expect(handler).toHaveBeenCalledTimes(1);

    unlisten();
    await api.createItem("worktable", "two");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
