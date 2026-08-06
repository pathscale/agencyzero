import { render, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it } from "vitest";
import { setPrefs } from "~/stores/prefs";
import {
  isLimitLive,
  queueReason,
  shortModelName,
  useWorkspace,
  type Workspace,
  WorkspaceProvider,
} from "~/stores/workspace";

/**
 * Mounts the provider and hands back the live workspace once it has loaded.
 *
 * Outside Tauri `selectApi` picks the mock, so every test here runs against
 * the design fixtures: three projects, two tool calls running on WorkTable,
 * and a CRITICAL hold plus a rate limit on api.support.cafe.
 */
async function mountWorkspace(): Promise<Workspace> {
  let workspace!: Workspace;

  function Probe() {
    workspace = useWorkspace();
    return null;
  }

  render(() => (
    <WorkspaceProvider>
      <Probe />
    </WorkspaceProvider>
  ));

  await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });
  return workspace;
}

const keys = (workspace: Workspace) => workspace.state.tabs.map((tab) => tab.key);

beforeEach(() => {
  setPrefs("lastTabKey", "home");
  // These scenarios predate tab restore, so they remember everything open.
  setPrefs("openTabKeys", ["worktable", "cafe", "agencyzero"]);
});

describe("startup", () => {
  it("opens Home plus the remembered tabs, in project order", async () => {
    const workspace = await mountWorkspace();
    expect(keys(workspace)).toEqual(["home", "worktable", "cafe", "agencyzero"]);
  });

  /*
   * The strip is the user's arrangement, and it survives the process: boot
   * used to open a tab per project, which quietly un-did every close.
   */
  it("leaves a closed tab closed across a restart", async () => {
    setPrefs("openTabKeys", ["cafe"]);
    const workspace = await mountWorkspace();
    expect(keys(workspace)).toEqual(["home", "cafe"]);
  });

  it("falls back to the mock backend when there is no Rust to talk to", async () => {
    const workspace = await mountWorkspace();
    expect(workspace.state.backend).toBe("mock");
  });

  it("derives approval postures from provider capabilities", async () => {
    const workspace = await mountWorkspace();
    expect(workspace.permissionsFor("claude")).toContain("ask");
    expect(workspace.permissionsFor("codex")).toContain("ask");
  });
});

describe("cycleTab", () => {
  it("steps forward and wraps at the end", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.focus("agencyzero");

    workspace.actions.cycleTab(1);
    expect(workspace.state.activeKey).toBe("home");
  });

  it("steps back and wraps at the start", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.focus("home");

    workspace.actions.cycleTab(-1);
    expect(workspace.state.activeKey).toBe("agencyzero");
  });

  /*
   * The two features have to agree, and they do because cycling is index-based
   * on the same array the strip renders — there is no second ordering to drift.
   */
  it("follows the strip after a reorder rather than the original order", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.moveTab("agencyzero", 1);
    expect(keys(workspace)).toEqual(["home", "agencyzero", "worktable", "cafe"]);

    workspace.actions.focus("home");
    workspace.actions.cycleTab(1);
    expect(workspace.state.activeKey).toBe("agencyzero");
  });
});

describe("moveTab", () => {
  it("moves a tab to the requested index", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.moveTab("cafe", 1);
    expect(keys(workspace)).toEqual(["home", "cafe", "worktable", "agencyzero"]);
  });

  it("will not move Home, which anchors the strip", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.moveTab("home", 2);
    expect(keys(workspace)).toEqual(["home", "worktable", "cafe", "agencyzero"]);
  });

  it("will not drop another tab in front of Home", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.moveTab("agencyzero", 0);
    expect(keys(workspace)).toEqual(["home", "agencyzero", "worktable", "cafe"]);
  });

  it("clamps past the end instead of dropping the tab", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.moveTab("worktable", 99);
    expect(keys(workspace)).toEqual(["home", "cafe", "agencyzero", "worktable"]);
  });

  it("persists the project order, so it survives a restart", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.moveTab("agencyzero", 1);
    await workspace.actions.commitTabOrder();

    await waitFor(() =>
      expect(workspace.state.projects.map((project) => project.id)).toEqual([
        "agencyzero",
        "worktable",
        "cafe",
      ]),
    );
  });
});

describe("closeTab", () => {
  it("refuses to close Home", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.closeTab("home");
    expect(keys(workspace)).toContain("home");
  });

  it("falls back to the tab on the left, which is where the eye already is", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.focus("cafe");
    workspace.actions.closeTab("cafe");

    expect(keys(workspace)).toEqual(["home", "worktable", "agencyzero"]);
    expect(workspace.state.activeKey).toBe("worktable");
  });

  it("leaves the active tab alone when a different one is closed", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.focus("agencyzero");
    workspace.actions.closeTab("worktable");
    expect(workspace.state.activeKey).toBe("agencyzero");
  });
});

describe("openDraft", () => {
  it("focuses the Untitled tab already open rather than stacking a second", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.openDraft();
    const draftKey = workspace.state.activeKey;

    workspace.actions.focus("home");
    workspace.actions.openDraft();

    expect(workspace.state.tabs.filter((tab) => tab.kind === "draft")).toHaveLength(1);
    expect(workspace.state.activeKey).toBe(draftKey);
  });
});

describe("tabStatus", () => {
  /*
   * Precedence is the point: an unresolved hold outranks a rate limit, which
   * outranks a live tool call. Storing this would mean four call sites
   * remembering to keep it in step, so it is derived.
   */
  it("reports a CRITICAL hold as an error, over the rate limit on the same tab", async () => {
    const workspace = await mountWorkspace();
    expect(workspace.state.rateLimits.cafe).toBeTruthy();
    expect(workspace.tabStatus("cafe")).toBe("error");
  });

  it("falls back to the rate limit once the hold is resolved", async () => {
    const workspace = await mountWorkspace();
    const hold = workspace.state.messages.cafe.find((message) => message.moderation?.needsApproval);

    await workspace.actions.resolveModeration(hold!.id, true);

    await waitFor(() => expect(workspace.tabStatus("cafe")).toBe("blocked"));
  });

  it("reports a project with live tool calls as running", async () => {
    const workspace = await mountWorkspace();
    expect(workspace.tabStatus("worktable")).toBe("running");
  });

  /*
   * `ready` and `quiet` used to be one grey state, so a project sitting there
   * waiting for you looked exactly like one you had closed out. The project's
   * own status is what separates them.
   */
  it("reports an idle project that has not started as quiet", async () => {
    const workspace = await mountWorkspace();
    // The `agencyzero` fixture is `pending`: not started, so not waiting on you.
    expect(workspace.state.projects.find((p) => p.id === "agencyzero")?.status).toBe("pending");
    expect(workspace.tabStatus("agencyzero")).toBe("quiet");
  });

  it("reports an idle active project as ready, not quiet", async () => {
    const workspace = await mountWorkspace();
    await workspace.actions.cancelRun("worktable");

    // `worktable` is `active`, so with nothing running it is waiting for input.
    await waitFor(() => expect(workspace.tabStatus("worktable")).toBe("ready"));
  });

  it("does not turn a deliberate cancellation into an error message", async () => {
    const workspace = await mountWorkspace();

    await workspace.actions.cancelRun("worktable");

    await waitFor(() => expect(workspace.tabStatus("worktable")).toBe("ready"));
    expect(
      workspace.state.messages.worktable.some(
        (message) => message.body === "The run stopped: canceled",
      ),
    ).toBe(false);
  });

  /*
   * An unanswered `@agency:ask` calls for attention by urgency: `blocking`
   * reads as blocked (red). `cafe` carries one blocking question in the
   * fixtures; with its moderation hold resolved, that question is what keeps
   * the tab red. A question is its own entity, beside the PR chips.
   */
  it("keeps a project with a blocking question blocked after the hold clears", async () => {
    const workspace = await mountWorkspace();
    // Opening the tab loads its questions into the store.
    await workspace.actions.focus("cafe");
    await waitFor(() => expect((workspace.state.questions.cafe ?? []).length).toBeGreaterThan(0));

    // Resolve every moderation hold so nothing but the question can hold the
    // dot: this proves the question is what keeps it red, not a lingering hold.
    for (const held of workspace.state.messages.cafe.filter(
      (message) => message.moderation?.needsApproval,
    )) {
      await workspace.actions.resolveModeration(held.id, true);
    }
    await waitFor(() =>
      expect(
        workspace.state.messages.cafe.some((message) => message.moderation?.needsApproval),
      ).toBe(false),
    );

    expect(workspace.tabStatus("cafe")).toBe("blocked");
  });

  it("clears a standing question as soon as its reply is accepted", async () => {
    const workspace = await mountWorkspace();
    await workspace.actions.focus("cafe");
    await waitFor(() => expect(workspace.state.questions.cafe?.[0]?.answered).toBe(false));

    await workspace.actions.send("cafe", "Keep patching the integration.");

    expect(workspace.state.questions.cafe[0].answered).toBe(true);
    expect(
      workspace.state.messages.cafe.some(
        (message) => message.author === "agent" && message.body.includes("Keep patching"),
      ),
    ).toBe(false);
  });

  /*
   * The older attention signal: an item moved to `questions` by
   * `items.state`, distinct from an `@agency:ask` row. Any tab that needs a
   * human turns red, so this gates the dot too. `worktable` is active; parking
   * an item on `questions` must make it blocked rather than leave it ready.
   */
  it("reports a project with an item on questions as blocked", async () => {
    const workspace = await mountWorkspace();
    await workspace.actions.cancelRun("worktable");
    await waitFor(() => expect(workspace.tabStatus("worktable")).toBe("ready"));

    const item = workspace.state.items.worktable[0];
    await workspace.actions.setItemStatus(item.id, "questions");

    await waitFor(() => expect(workspace.tabStatus("worktable")).toBe("blocked"));
  });
});

describe("openItemCount", () => {
  it("counts what is left to do, so finished items drop out", async () => {
    const workspace = await mountWorkspace();
    // WorkTable has five items, one of them finished.
    expect(workspace.itemsFor("worktable")).toHaveLength(5);
    expect(workspace.openItemCount("worktable")).toBe(4);
  });
});

describe("createProject", () => {
  it("turns the draft into the project tab instead of opening a second one", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.openDraft();
    const draftKey = workspace.state.activeKey;

    await workspace.actions.createProject("Port the emitter", draftKey);

    expect(workspace.state.tabs.filter((tab) => tab.kind === "draft")).toHaveLength(0);
    expect(workspace.state.tabs.filter((tab) => tab.label === "Port the emitter")).toHaveLength(1);
    expect(workspace.activeTab().label).toBe("Port the emitter");
  });

  /*
   * The tab is converted to `kind: "project"` the moment the command returns.
   * If the record is left to arrive on `project:created`, there is a window in
   * which the tab points at an id `state.projects` has never heard of — and
   * that is exactly what rendered "This project could not be loaded".
   *
   * Asserted synchronously, with no `waitFor`: waiting for the event to land
   * is the bug, not the fix.
   */
  it("has the project in the store the instant the tab becomes one", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.openDraft();
    const draftKey = workspace.state.activeKey;

    await workspace.actions.createProject("Port the emitter", draftKey);

    const tab = workspace.activeTab();
    expect(tab.kind).toBe("project");
    expect(tab.projectId).not.toBeNull();
    expect(workspace.state.projects.find((project) => project.id === tab.projectId)).toBeDefined();
  });

  /*
   * The event follows the optimistic write. Both carry the same id, so the
   * store must end up with one project, not two.
   */
  it("does not duplicate the project when its event lands afterwards", async () => {
    const workspace = await mountWorkspace();
    const before = workspace.state.projects.length;
    workspace.actions.openDraft();

    await workspace.actions.createProject("Port the emitter", workspace.state.activeKey);

    await waitFor(() => {
      expect(workspace.state.projects).toHaveLength(before + 1);
    });
  });
});

describe("task correlation", () => {
  /*
   * Labels are not identities. Two `cargo test` calls, two reads of the same
   * file or two calls to the same MCP tool share one, and removing by label
   * cleared every match when the first finished.
   */
  it("completes only the tool call that finished, not every task sharing its label", async () => {
    const workspace = await mountWorkspace();
    const before = workspace.state.running.worktable;
    expect(before).toHaveLength(2);

    await workspace.actions.cancelTask("tc-wt-test");

    await waitFor(() => {
      const after = workspace.state.running.worktable;
      expect(after).toHaveLength(1);
      expect(after[0].toolCallId).toBe("tc-wt-rg");
    });
  });
});

describe("shortModelName", () => {
  it("squeezes a windowed name to its size", () => {
    expect(shortModelName("Opus (1M context)")).toBe("Opus 1M");
    expect(shortModelName("Sonnet (200k context)")).toBe("Sonnet 200K");
  });

  it("drops a non-window parenthetical", () => {
    expect(shortModelName("GPT-5.6 (sol)")).toBe("GPT-5.6");
  });

  it("leaves a plain name untouched", () => {
    expect(shortModelName("Haiku")).toBe("Haiku");
  });
});

describe("isLimitLive", () => {
  const now = Date.parse("2026-07-29T12:00:00Z");
  const limit = (resetsAt: string | null) => ({
    projectId: "p",
    agent: "claude" as const,
    // A real refusal. `isLimitLive` is only about expiry; whether a record
    // restricts anything is a separate question, asked at the call sites.
    isBlocking: true,
    isWarning: false,
    message: "Rate limited",
    resetsAt,
  });

  /*
   * Without this a single rate-limit event leaves the tab blocked for the rest
   * of the session: nothing observes `resetsAt` passing, and a suspended app
   * misses timers, so expiry has to be re-derived every time it is read.
   */
  it("treats a limit past its reset as spent", () => {
    expect(isLimitLive(limit("2026-07-29T11:59:00Z"), now)).toBe(false);
  });

  it("keeps one that has not reset yet", () => {
    expect(isLimitLive(limit("2026-07-29T12:34:00Z"), now)).toBe(true);
  });

  it("keeps a limit the provider gave no reset time for, rather than guessing", () => {
    expect(isLimitLive(limit(null), now)).toBe(true);
    expect(isLimitLive(limit("nonsense"), now)).toBe(true);
  });
});

/*
 * Which refusals are worth waiting out. The backend's own wording is asserted
 * in `queue_markers` (apps/gui/src/projects.rs) — between the two, rewording a
 * refusal on one side without the other fails a test rather than quietly
 * turning a queued prompt into red text under the composer.
 */
describe("queueReason", () => {
  it("waits out a command holding the session", () => {
    expect(
      queueReason(
        new Error(
          "a command is running in this project — the message will be sent when it finishes",
        ),
      ),
    ).toBe("compacting");
  });

  it("waits out a run that has the slot", () => {
    expect(
      queueReason(new Error("a run is already active in this project — stop it or let it finish")),
    ).toBe("busy");
    expect(
      queueReason(new Error("a run is already active in this project — let it finish first")),
    ).toBe("busy");
  });

  /*
   * The rule that keeps a prompt from waiting forever. A refusal the window
   * cannot name is not a busy signal — nothing will free, nothing will flush —
   * so the words go back to the composer where they can be seen and resent.
   */
  it("hands back anything it cannot name, rather than queueing it", () => {
    expect(queueReason(new Error("the working directory no longer exists"))).toBeNull();
    expect(queueReason(new Error("you are out of quota"))).toBeNull();
    expect(queueReason("not even an error")).toBeNull();
  });
});

describe("project deletion", () => {
  it("purges every collection the project owned", async () => {
    const workspace = await mountWorkspace();
    expect(workspace.state.messages.worktable).toBeTruthy();

    workspace.actions.purgeProject("worktable");

    for (const bucket of [
      "items",
      "messages",
      "running",
      "taskLog",
      "logTotals",
      "rateLimits",
      "agentIo",
      "streaming",
      "pullRequests",
      "questions",
      "pendingApprovals",
      "runStatus",
      "queued",
      "compacting",
      "commands",
    ] as const) {
      expect(workspace.state[bucket]).not.toHaveProperty("worktable");
    }
    expect(workspace.state.tabs.map((tab) => tab.key)).not.toContain("worktable");
  });

  /*
   * The 30s-clock crash: `tabStatus` re-reads `state.rateLimits[projectId]`
   * every tick, so it must stay safe as that record is mutated and cleared. A
   * project whose rate-limit record was purged must read as a plain status
   * rather than throw "undefined is not an object" on the nested proxy.
   */
  it("keeps tabStatus safe after a project's rate-limit record is removed", async () => {
    const workspace = await mountWorkspace();
    expect(workspace.state.rateLimits.cafe).toBeTruthy();

    // Purge removes the whole per-project record (a top-level key delete, the
    // safe way) — the case the buggy nested delete used to strand.
    workspace.actions.purgeProject("cafe");
    expect(workspace.state.rateLimits).not.toHaveProperty("cafe");
    expect(() => workspace.tabStatus("cafe")).not.toThrow();
  });
});

describe("the data location", () => {
  /*
   * The picker used to be a `window.prompt`, which a Tauri webview never draws:
   * the click landed, `null` came straight back, and the row was unreachable.
   * Cancelling now takes the same path a closed picker does, so the one thing
   * worth holding is that it stays a no-op rather than clearing the pointer.
   */
  it("leaves the location alone when the picker is cancelled", async () => {
    const workspace = await mountWorkspace();
    const before = workspace.state.dataLocation;

    // The mock has no native picker, so it answers "cancelled" every time.
    await workspace.actions.chooseDataLocation();

    expect(workspace.state.dataLocation).toEqual(before);
  });
});

describe("delivery receipts", () => {
  /*
   * The first receipt for a project arrives before any receipt record exists,
   * so the nested set had no object to write the message-id key onto and threw
   * inside the event handler. Sending through the mock exercises the same
   * listener path as Rust and must record that first acknowledgement.
   */
  it("records the first receipt through the normal send path", async () => {
    const workspace = await mountWorkspace();
    expect(workspace.state.messageReceipts.worktable).toBeUndefined();

    await workspace.actions.send("worktable", "receipt regression");

    const message = workspace.state.messages.worktable?.find(
      (candidate) => candidate.body === "receipt regression",
    );
    expect(message).toBeDefined();
    expect(workspace.state.messageReceipts.worktable?.[message?.id ?? ""]).toBe("sent");
  });
});
