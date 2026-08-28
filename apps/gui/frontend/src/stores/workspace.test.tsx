import { flush } from "solid-js";
import { beforeEach, describe, expect, it } from "vitest";
import { SETTINGS, setClaudeUsageError, setSyncProjectError } from "~/api/fixtures";
import { revealItemReference } from "~/lib/itemReference";
import { prefs, setPrefs } from "~/stores/prefs";
import {
  claudeUsageBackoffMs,
  isLimitLive,
  monotonicUsage,
  queueReason,
  shortModelName,
  type Workspace,
} from "~/stores/workspace";
import { bootWorkspace, waitFor } from "~/test/reactive";

describe("running usage continuity", () => {
  it("keeps cumulative traffic and cost through a lower post-compact snapshot", () => {
    expect(monotonicUsage(91_800_000, 225_000)).toBe(91_800_000);
    expect(monotonicUsage(46.768, 0.14)).toBe(46.768);
    expect(monotonicUsage(null, 225_000)).toBe(225_000);
  });
});

describe("Claude usage backoff", () => {
  it("waits longer after each rejection and stops doubling at a quarter hour", () => {
    // A rejection has to cost more than the poll period, or the next tick asks
    // again and the alternating success/failure loop never actually breaks.
    expect(claudeUsageBackoffMs(1)).toBe(120_000);
    expect(claudeUsageBackoffMs(2)).toBe(240_000);
    expect(claudeUsageBackoffMs(3)).toBe(480_000);
    expect(claudeUsageBackoffMs(4)).toBe(900_000);
    expect(claudeUsageBackoffMs(40)).toBe(900_000);
  });

  it("asks again immediately once a reading succeeds", () => {
    expect(claudeUsageBackoffMs(0)).toBe(0);
  });

  it("skips the poll while backed off, and still answers the Refresh button", async () => {
    const workspace = await mountWorkspace();
    setClaudeUsageError("Claude usage is rate limited; retry after 0");

    await expect(workspace.actions.refreshClaudeUsage()).rejects.toThrow(/rate limited/);
    expect(workspace.state.claudeUsage).toBeNull();

    // The budget frees up, but the next tick is inside the backoff window: a
    // reading now would prove the poll never actually stopped asking.
    setClaudeUsageError(null);
    await workspace.actions.refreshClaudeUsage();
    expect(workspace.state.claudeUsage).toBeNull();

    await workspace.actions.refreshClaudeUsage({ force: true });
    expect(workspace.state.claudeUsage).not.toBeNull();

    // One success clears the streak, so the ordinary poll resumes.
    await workspace.actions.refreshClaudeUsage();
    expect(workspace.state.claudeUsage).not.toBeNull();
  });

  /*
   * A failure has to leave a reason behind.
   *
   * The comment on the backoff says the last good reading stays up, and that is
   * only true once there is one. `claudeUsage` starts null and the sole
   * unforced caller is the strip's 60s poll, which returns early while the
   * backoff is armed — so a streak beginning at boot removed the chip entirely
   * for up to a quarter of an hour, with the reason discarded by the
   * `.catch(() => undefined)` at the call site. The endpoint's budget belongs
   * to the login, so a Claude Code or Claude Desktop session alongside this app
   * is enough to cause it.
   */
  it("records why usage is missing, so the chip can say so", async () => {
    const workspace = await mountWorkspace();
    expect(workspace.state.claudeUsageError).toBeNull();

    setClaudeUsageError("Claude usage is rate limited; retry after 0");
    await expect(workspace.actions.refreshClaudeUsage()).rejects.toThrow(/rate limited/);

    // No reading, and a reason rather than silence.
    expect(workspace.state.claudeUsage).toBeNull();
    expect(workspace.state.claudeUsageError).toMatch(/rate limited/);

    // And it clears on the next success, so a recovered budget stops nagging.
    setClaudeUsageError(null);
    await workspace.actions.refreshClaudeUsage({ force: true });
    expect(workspace.state.claudeUsage).not.toBeNull();
    expect(workspace.state.claudeUsageError).toBeNull();
  });
});

/**
 * Mounts the provider and hands back the live workspace once it has loaded.
 *
 * Outside Tauri `selectApi` picks the mock, so every test here runs against
 * the design fixtures: three projects, two tool calls running on foo.bar,
 * and a CRITICAL hold plus a rate limit on baz.qux.
 */
async function mountWorkspace(): Promise<Workspace> {
  return bootWorkspace();
}

const keys = (workspace: Workspace) => workspace.state.tabs.map((tab) => tab.key);

beforeEach(() => {
  setClaudeUsageError(null);
  setSyncProjectError(null);
  SETTINGS.workspaceTabs = null;
  setPrefs((d) => {
    d.lastTabKey = "home";
  });
  // These scenarios predate tab restore, so they remember everything open.
  setPrefs((d) => {
    d.openTabKeys = ["worktable", "cafe", "quux"];
  });
});

describe("startup", () => {
  it("keeps the workspace and Settings usable when proxy reattachment fails", async () => {
    setSyncProjectError("AgencyProxy stopped unexpectedly");
    const workspace = await mountWorkspace();

    expect(workspace.state.boot.status).toBe("ready");
    workspace.actions.openSettings();
    await waitFor(() => expect(workspace.state.activeKey).toBe("settings"));
  });

  it("opens Home plus the remembered tabs, in project order", async () => {
    const workspace = await mountWorkspace();
    expect(keys(workspace)).toEqual(["home", "worktable", "cafe", "quux"]);
  });

  /*
   * A restored tab has its project loaded, not just its key in the strip.
   *
   * Boot wrote the restored strip into the store and then read `state.tabs`
   * back to decide which projects to fetch. Solid 2 defers that write, so the
   * read saw Home alone: boot logged "loading 0 open project(s)" and fetched
   * nothing, while the strip still rendered every remembered tab. The tabs
   * were there and empty, which is why asserting on keys alone missed it.
   */
  it("loads the messages for every tab it restored, not just their keys", async () => {
    const workspace = await mountWorkspace();

    expect(keys(workspace)).toEqual(["home", "worktable", "cafe", "quux"]);
    for (const project of ["worktable", "cafe", "quux"]) {
      await waitFor(() => expect(workspace.state.messages[project]).toBeTruthy());
    }
  });

  /*
   * The strip is the user's arrangement, and it survives the process: boot
   * used to open a tab per project, which quietly un-did every close.
   */
  it("leaves a closed tab closed across a restart", async () => {
    setPrefs((d) => {
      d.openTabKeys = ["cafe"];
    });
    const workspace = await mountWorkspace();
    expect(keys(workspace)).toEqual(["home", "cafe"]);
  });

  it("prefers the portable backup state and restores its project order and focus", async () => {
    SETTINGS.workspaceTabs = {
      openProjectKeys: ["quux", "cafe"],
      activeProjectKey: "cafe",
      scrollPositions: { quux: 321, cafe: 0 },
    };
    setPrefs((d) => {
      d.openTabKeys = ["worktable"];
    });
    setPrefs((d) => {
      d.lastTabKey = "worktable";
    });

    const workspace = await mountWorkspace();

    expect(keys(workspace)).toEqual(["home", "quux", "cafe"]);
    await waitFor(() => expect(workspace.state.activeKey).toBe("cafe"));
    expect(workspace.state.transcriptPositions).toEqual({ quux: 321, cafe: 0 });
  });

  it("migrates the old webview preference into backup-backed settings", async () => {
    setPrefs((d) => {
      d.openTabKeys = ["cafe"];
    });
    setPrefs((d) => {
      d.lastTabKey = "cafe";
    });
    // Boot reads these while deciding what to restore, so they have to land
    // before the provider mounts rather than after.
    flush();

    const workspace = await mountWorkspace();

    await waitFor(() =>
      expect(workspace.state.settings?.workspaceTabs).toEqual({
        openProjectKeys: ["cafe"],
        activeProjectKey: "cafe",
        scrollPositions: { cafe: 0 },
      }),
    );
  });

  it("persists project focus without replacing it when Settings covers the strip", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.focus("quux");

    await waitFor(() =>
      expect(workspace.state.settings?.workspaceTabs?.activeProjectKey).toBe("quux"),
    );

    workspace.actions.openSettings();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(workspace.state.settings?.workspaceTabs?.activeProjectKey).toBe("quux");
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

describe("item reference routing", () => {
  it("routes the transcript module directly into the mounted workspace", async () => {
    const workspace = await mountWorkspace();
    setPrefs((d) => {
      d.projectPanelVisible = false;
    });
    setPrefs((d) => {
      d.panelSections.items = false;
    });

    revealItemReference("cafe-0");

    await waitFor(() => expect(workspace.state.activeKey).toBe("cafe"));
    expect(workspace.state.itemReveal?.id).toBe("cafe-0");
    expect(prefs.projectPanelVisible).toBe(true);
    expect(prefs.panelSections.items).toBe(true);
  });

  it("opens the owning project and reveals its Items panel", async () => {
    const workspace = await mountWorkspace();
    setPrefs((d) => {
      d.projectPanelVisible = false;
    });
    setPrefs((d) => {
      d.panelSections.items = false;
    });

    expect(workspace.actions.revealItem("cafe-0")).toBe(true);
    await waitFor(() => expect(workspace.state.activeKey).toBe("cafe"));
    expect(workspace.state.itemReveal?.id).toBe("cafe-0");
    expect(prefs.projectPanelVisible).toBe(true);
    expect(prefs.panelSections.items).toBe(true);
  });

  it("leaves navigation unchanged for an unknown item", async () => {
    const workspace = await mountWorkspace();
    const before = workspace.state.activeKey;

    expect(workspace.actions.revealItem("item-missing")).toBe(false);
    await waitFor(() => expect(workspace.state.activeKey).toBe(before));
  });
});

describe("cycleTab", () => {
  it("steps forward and wraps at the end", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.focus("quux");

    workspace.actions.cycleTab(1);
    await waitFor(() => expect(workspace.state.activeKey).toBe("home"));
  });

  it("steps back and wraps at the start", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.focus("home");

    workspace.actions.cycleTab(-1);
    await waitFor(() => expect(workspace.state.activeKey).toBe("quux"));
  });

  /*
   * The two features have to agree, and they do because cycling is index-based
   * on the same array the strip renders — there is no second ordering to drift.
   */
  it("follows the strip after a reorder rather than the original order", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.moveTab("quux", 1);
    await waitFor(() => expect(keys(workspace)).toEqual(["home", "quux", "worktable", "cafe"]));

    workspace.actions.focus("home");
    workspace.actions.cycleTab(1);
    await waitFor(() => expect(workspace.state.activeKey).toBe("quux"));
  });
});

describe("moveTab", () => {
  it("moves a tab to the requested index", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.moveTab("cafe", 1);
    await waitFor(() => expect(keys(workspace)).toEqual(["home", "cafe", "worktable", "quux"]));
  });

  it("will not move Home, which anchors the strip", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.moveTab("home", 2);
    await waitFor(() => expect(keys(workspace)).toEqual(["home", "worktable", "cafe", "quux"]));
  });

  it("will not drop another tab in front of Home", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.moveTab("quux", 0);
    await waitFor(() => expect(keys(workspace)).toEqual(["home", "quux", "worktable", "cafe"]));
  });

  it("clamps past the end instead of dropping the tab", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.moveTab("worktable", 99);
    await waitFor(() => expect(keys(workspace)).toEqual(["home", "cafe", "quux", "worktable"]));
  });

  it("persists the project order, so it survives a restart", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.moveTab("quux", 1);
    // `commitTabOrder` reads the strip the move above rewrote.
    flush();
    await workspace.actions.commitTabOrder();

    await waitFor(() =>
      expect(workspace.state.projects.map((project) => project.id)).toEqual([
        "quux",
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
    flush();
    expect(keys(workspace)).toContain("home");
  });

  it("falls back to the tab on the left, which is where the eye already is", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.focus("cafe");
    // `closeTab` reads `activeKey` to decide where the eye falls back to, so
    // the focus above has to have landed before it runs.
    flush();
    workspace.actions.closeTab("cafe");
    flush();

    await waitFor(() => expect(keys(workspace)).toEqual(["home", "worktable", "quux"]));
    await waitFor(() => expect(workspace.state.activeKey).toBe("worktable"));
  });

  it("leaves the active tab alone when a different one is closed", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.focus("quux");
    workspace.actions.closeTab("worktable");
    await waitFor(() => expect(workspace.state.activeKey).toBe("quux"));
  });
});

describe("openDraft", () => {
  it("focuses the Untitled tab already open rather than stacking a second", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.openDraft();
    // Land the open before reading which key it produced, or `draftKey` is
    // whatever was focused beforehand and the assertion below chases it.
    flush();
    const draftKey = workspace.state.activeKey;

    workspace.actions.focus("home");
    workspace.actions.openDraft();
    flush();

    expect(workspace.state.tabs.filter((tab) => tab.kind === "draft")).toHaveLength(1);
    await waitFor(() => expect(workspace.state.activeKey).toBe(draftKey));
  });

  /*
   * The draft branch of `reconcileTabModels` used to move the agent with the
   * model, so a settings write - any settings write, including one the agent
   * itself makes - put a draft on Codex back on the default. The picker had
   * been used, the pill re-rendered as Claude, and the prompt went to Claude.
   */
  it("keeps a draft on the agent that was picked when settings are written", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.openDraft();
    flush();
    const draftKey = workspace.state.activeKey;

    workspace.actions.setTabModel(draftKey, "codex", "gpt-5.6-sol", "read_only");
    flush();

    // An unrelated setting: nothing here mentions an agent or a model.
    await workspace.actions.saveSettings({ defaultPermission: "plan" });
    flush();

    const draft = () => workspace.state.tabs.find((tab) => tab.key === draftKey);
    await waitFor(() => expect(draft()?.agent).toBe("codex"));
    // The model too. Resetting Sol to Codex's default is the same bug one
    // level down, and it would send the prompt to a model nobody chose.
    expect(draft()?.model).toBe("gpt-5.6-sol");
  });

  it("still follows the default agent on a draft nobody has picked on", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.openDraft();
    flush();
    const draftKey = workspace.state.activeKey;

    await workspace.actions.saveSettings({ defaultAgent: "codex" });
    flush();

    // Untouched, so it tracks the default: this is what the draft branch is
    // for, and the fix must not cost it.
    const draft = () => workspace.state.tabs.find((tab) => tab.key === draftKey);
    await waitFor(() => expect(draft()?.agent).toBe("codex"));
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
    expect(workspace.state.projects.find((p) => p.id === "quux")?.status).toBe("pending");
    expect(workspace.tabStatus("quux")).toBe("quiet");
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
   * An item's workflow state is backlog metadata, not proof the current tab is
   * blocked. It can remain on `questions` after its tracked question is
   * answered or while the agent works on another item. Only a live unanswered
   * question or approval should turn the tab red.
   */
  it("does not let an item on questions leave the tab falsely blocked", async () => {
    const workspace = await mountWorkspace();
    await workspace.actions.cancelRun("worktable");
    await waitFor(() => expect(workspace.tabStatus("worktable")).toBe("ready"));

    const item = workspace.state.items.worktable[0];
    await workspace.actions.setItemStatus(item.id, "questions");

    await waitFor(() => expect(workspace.tabStatus("worktable")).toBe("ready"));
  });
});

describe("openItemCount", () => {
  it("counts what is left to do, so finished items drop out", async () => {
    const workspace = await mountWorkspace();
    // WorkTable has five items, one of them finished.
    expect(workspace.itemsFor("worktable")).toHaveLength(5);
    expect(workspace.openItemCount("worktable")).toBe(4);
  });

  it("does not count canceled work as still open", async () => {
    const workspace = await mountWorkspace();

    await workspace.actions.setItemStatus("worktable-1", "canceled");

    expect(workspace.openItemCount("worktable")).toBe(3);
  });
});

describe("createProject", () => {
  /*
   * The new project takes the eye, and this asserts it without a `flush`.
   *
   * `createProject` rewrites the draft tab's key to the project id and then
   * focuses that key in the same tick. Solid 2 defers the rewrite, so
   * `focus`'s membership guard did not find the tab its own caller had just
   * renamed and `activeKey` stayed on the dead draft key: the owner created a
   * project and was left looking at nothing. The guard now takes `justOpened`
   * from this path.
   *
   * Written against `waitFor` rather than a synchronous read on purpose. The
   * question is whether focus lands at all, not when the queue drains, so
   * this stays honest however the harness is flushed.
   */
  it("leaves the eye on the project it just created", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.openDraft();
    flush();
    const draftKey = workspace.state.activeKey;

    await workspace.actions.createProject("Port the emitter", draftKey);

    // The eye moved off the draft and onto a real project tab. Both halves
    // matter: staying on `draftKey` was the bug, and a key that is no longer
    // the draft but names no tab would be just as broken.
    await waitFor(() => expect(workspace.activeTab().kind).toBe("project"));
    expect(workspace.state.activeKey).not.toBe(draftKey);
    expect(workspace.activeTab().label).toBe("Port the emitter");
  });

  it("turns the draft into the project tab instead of opening a second one", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.openDraft();
    flush();
    const draftKey = workspace.state.activeKey;

    await workspace.actions.createProject("Port the emitter", draftKey);
    flush();

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
    flush();
    const draftKey = workspace.state.activeKey;

    await workspace.actions.createProject("Port the emitter", draftKey);
    flush();

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

describe("optimistic item persistence", () => {
  it("paints a created row before its command settles", async () => {
    const workspace = await mountWorkspace();
    const pending = workspace.actions.createItem("worktable", "optimistic paint");
    flush();

    expect(
      workspace.state.items.worktable.some(
        (item) => item.title === "optimistic paint" && item.id.startsWith("optimistic-item-"),
      ),
    ).toBe(true);

    await pending;
    await waitFor(() => {
      const matches = workspace.state.items.worktable.filter(
        (item) => item.title === "optimistic paint",
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.id).not.toMatch(/^optimistic-item-/);
    });
  });

  it("removes a row before its delete command settles", async () => {
    const workspace = await mountWorkspace();
    const id = workspace.state.items.worktable.find((item) => !item.archived)?.id;
    if (!id) throw new Error("an ordinary item is required");

    const pending = workspace.actions.deleteItem(id);
    flush();
    expect(workspace.state.items.worktable.some((item) => item.id === id)).toBe(false);
    await pending;
  });
});

describe("item forks", () => {
  it("opens one linked child chat and inherits the parent tab selection", async () => {
    const workspace = await mountWorkspace();
    const parent = workspace.state.tabs.find((tab) => tab.projectId === "worktable");
    expect(parent).toBeDefined();

    const fork = await workspace.actions.forkItem("worktable-1");
    const reopened = await workspace.actions.forkItem("worktable-1");
    flush();
    const tab = workspace.state.tabs.find((candidate) => candidate.projectId === fork.id);

    expect(reopened.id).toBe(fork.id);
    await waitFor(() => expect(workspace.state.activeKey).toBe(fork.id));
    expect(fork.forkedFrom).toEqual({ projectId: "worktable", itemId: "worktable-1" });
    expect(tab).toMatchObject({
      agent: parent?.agent,
      model: parent?.model,
      effort: parent?.effort,
      permission: parent?.permission,
    });
    expect(
      workspace.state.tabs.filter((candidate) => candidate.projectId === fork.id),
    ).toHaveLength(1);

    workspace.actions.setTabModel("worktable", "codex", "gpt-5.4", "auto", "high");

    flush();
    expect(workspace.state.tabs.find((candidate) => candidate.projectId === fork.id)).toMatchObject(
      { agent: "codex", model: "gpt-5.4", permission: "auto", effort: "high" },
    );

    workspace.actions.closeTab(fork.id);
    workspace.actions.openProject(fork.id);
    flush();
    expect(workspace.state.tabs.find((candidate) => candidate.projectId === fork.id)).toMatchObject(
      { agent: "codex", model: "gpt-5.4", permission: "auto", effort: "high" },
    );
  });

  it("hides an archived fork anchor without removing its durable row", async () => {
    const workspace = await mountWorkspace();
    await workspace.actions.forkItem("worktable-1");
    await workspace.actions.deleteItem("worktable-1");

    await waitFor(() => {
      expect(
        workspace.state.items.worktable.find((item) => item.id === "worktable-1")?.archived,
      ).toBe(true);
    });
    expect(workspace.itemsFor("worktable").some((item) => item.id === "worktable-1")).toBe(false);
    expect(workspace.actions.revealItem("worktable-1")).toBe(true);
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
    flush();

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
    flush();
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

describe("backup portability", () => {
  it("writes stable webview preferences into the store before backup starts", async () => {
    const workspace = await mountWorkspace();
    setPrefs((d) => {
      d.uiSize = "extra-large";
    });
    setPrefs((d) => {
      d.expandedComposerKeys = ["project:worktable"];
    });
    setPrefs((d) => {
      d.composerDrafts["project:worktable"] = "do not treat as a preference";
    });
    // The backup snapshots the prefs store, so the writes above have to have
    // landed before it reads them.
    flush();

    await expect(workspace.actions.createStoreBackup()).rejects.toThrow(
      "the fixture backend has no durable store to back up",
    );
    flush();

    expect(workspace.state.settings?.uiPreferences.uiSize).toBe("extra-large");
    expect(workspace.state.settings?.uiPreferences.expandedComposerKeys).toEqual([
      "project:worktable",
    ]);
    expect(workspace.state.settings?.uiPreferences).not.toHaveProperty("composerDrafts");

    setPrefs((d) => {
      d.uiSize = "large";
    });
    setPrefs((d) => {
      d.expandedComposerKeys = [];
    });
    setPrefs((d) => {
      d.composerDrafts["project:worktable"] = "";
    });
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
