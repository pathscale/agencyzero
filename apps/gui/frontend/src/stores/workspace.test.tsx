import { render, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it } from "vitest";
import { setPrefs } from "~/stores/prefs";
import { useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";

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

  await waitFor(() => expect(workspace.state.isLoaded).toBe(true), { timeout: 5_000 });
  return workspace;
}

const keys = (workspace: Workspace) => workspace.state.tabs.map((tab) => tab.key);

beforeEach(() => {
  setPrefs("lastTabKey", "home");
});

describe("startup", () => {
  it("opens Home plus one tab per project, in project order", async () => {
    const workspace = await mountWorkspace();
    expect(keys(workspace)).toEqual(["home", "worktable", "cafe", "agencyzero"]);
  });

  it("falls back to the mock backend when there is no Rust to talk to", async () => {
    const workspace = await mountWorkspace();
    expect(workspace.state.backend).toBe("mock");
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

  it("reports an idle project as quiet", async () => {
    const workspace = await mountWorkspace();
    expect(workspace.tabStatus("agencyzero")).toBe("quiet");
  });

  it("goes quiet once the run is cancelled", async () => {
    const workspace = await mountWorkspace();
    await workspace.actions.cancelRun("worktable");
    await waitFor(() => expect(workspace.tabStatus("worktable")).toBe("quiet"));
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
});
