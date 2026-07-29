import { render, waitFor } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";

/**
 * Mounts the provider against the mock, which serves the same catalogues the
 * crate compiles in: nine Claude aliases plus four pinned ids, six Codex models,
 * and Copilot's `auto` plus twenty-three pinned ids.
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

const claude = (workspace: Workspace) => workspace.state.settings?.models.claude;

describe("the catalogue", () => {
  it("loads one entry per agent at boot", async () => {
    const workspace = await mountWorkspace();
    expect(workspace.state.models.map((entry) => entry.agent)).toEqual([
      "claude",
      "codex",
      "copilot",
    ]);
  });

  /*
   * Provenance is what tells a reader whether to trust a list, and two of the
   * three were not obtained from the installed binary. A boot that quietly
   * reported discovery it never performed would make the Settings line lie.
   */
  it("does not claim discovery it did not perform", async () => {
    const workspace = await mountWorkspace();
    expect(workspace.state.models.every((entry) => entry.discovered)).toBe(false);
  });

  it("carries each agent's own effort ladder rather than one shared list", async () => {
    const workspace = await mountWorkspace();
    const codex = workspace.state.models.find((entry) => entry.agent === "codex");
    const sol = codex?.models.find((model) => model.id === "gpt-5.6-sol");
    const older = codex?.models.find((model) => model.id === "gpt-5.5");

    expect(sol?.efforts).toContain("ultra");
    expect(older?.efforts).not.toContain("ultra");
  });
});

describe("choosing models", () => {
  it("adds a model to the picker", async () => {
    const workspace = await mountWorkspace();
    expect(claude(workspace)?.enabled).not.toContain("fable");

    await workspace.actions.toggleModel("claude", "fable", true);

    expect(claude(workspace)?.enabled).toContain("fable");
  });

  /*
   * Click order is not display order. A model checked last should still appear
   * where the vendor ranks it, not at the end of the menu.
   */
  it("keeps the selection in catalogue order however it was assembled", async () => {
    const workspace = await mountWorkspace();
    await workspace.actions.toggleModel("claude", "fable", true);
    await workspace.actions.toggleModel("claude", "best", true);

    expect(claude(workspace)?.enabled).toEqual([
      "default",
      "opus",
      "sonnet",
      "haiku",
      "fable",
      "best",
    ]);
  });

  it("removes a model from the picker", async () => {
    const workspace = await mountWorkspace();
    await workspace.actions.toggleModel("claude", "haiku", false);

    expect(claude(workspace)?.enabled).not.toContain("haiku");
  });

  /*
   * The invariant that keeps the prompt usable: an empty picker would leave the
   * composer with no model to send under.
   */
  it("refuses to remove the last enabled model", async () => {
    const workspace = await mountWorkspace();
    for (const id of ["default", "opus", "haiku"]) {
      await workspace.actions.toggleModel("claude", id, false);
    }
    expect(claude(workspace)?.enabled).toEqual(["sonnet"]);

    await workspace.actions.toggleModel("claude", "sonnet", false);

    expect(claude(workspace)?.enabled).toEqual(["sonnet"]);
  });

  /*
   * The other invariant: `default` must name something the picker still offers,
   * or the prompt would open on a model that is not in its own menu.
   */
  it("promotes another model when the default is removed", async () => {
    const workspace = await mountWorkspace();
    expect(claude(workspace)?.default).toBe("sonnet");

    await workspace.actions.toggleModel("claude", "sonnet", false);

    const selection = claude(workspace);
    expect(selection?.enabled).not.toContain("sonnet");
    expect(selection?.default).toBe("default");
    expect(selection?.enabled).toContain(selection?.default);
  });

  it("enables a model that is made the default", async () => {
    const workspace = await mountWorkspace();
    expect(claude(workspace)?.enabled).not.toContain("claude-opus-5");

    await workspace.actions.setDefaultModel("claude", "claude-opus-5");

    expect(claude(workspace)?.default).toBe("claude-opus-5");
    expect(claude(workspace)?.enabled).toContain("claude-opus-5");
  });

  it("keeps each agent's selection to itself", async () => {
    const workspace = await mountWorkspace();
    const codexBefore = [...(workspace.state.settings?.models.codex.enabled ?? [])];

    await workspace.actions.toggleModel("claude", "fable", true);

    expect(workspace.state.settings?.models.codex.enabled).toEqual(codexBefore);
  });
});

describe("what the prompt offers", () => {
  it("offers the enabled Claude models, in catalogue order", async () => {
    const workspace = await mountWorkspace();
    expect(workspace.promptModels().map((option) => option.value)).toEqual([
      "default",
      "opus",
      "sonnet",
      "haiku",
    ]);
  });

  /** The pill shows vendor names, not the raw ids that go on the command line. */
  it("labels an option with the vendor's display name", async () => {
    const workspace = await mountWorkspace();
    const sonnet = workspace.promptModels().find((option) => option.value === "sonnet");
    expect(sonnet?.label).toBe("Sonnet");
  });

  it("follows the selection as it changes", async () => {
    const workspace = await mountWorkspace();
    await workspace.actions.toggleModel("claude", "haiku", false);

    expect(workspace.promptModels().map((option) => option.value)).not.toContain("haiku");
  });

  /*
   * Claude only for now. Codex and Copilot are selectable in Settings so the
   * code review UI has something to open with, but nothing sends to them yet,
   * and a Codex id reaching the prompt would be sent to Claude.
   */
  it("never offers a model belonging to another agent", async () => {
    const workspace = await mountWorkspace();
    await workspace.actions.toggleModel("codex", "gpt-5.4", true);
    await workspace.actions.toggleModel("copilot", "gemini-3.6-flash", true);

    const offered = workspace.promptModels().map((option) => option.value);
    expect(offered).not.toContain("gpt-5.4");
    expect(offered).not.toContain("gemini-3.6-flash");
  });
});

describe("settings own the defaults", () => {
  /*
   * The bug this covers: `prefs.lastModel` used to seed a new tab and shadow the
   * configured default, so choosing Opus in Settings and opening a tab still
   * gave you Sonnet.
   */
  it("opens a new tab on the model Settings names, not the last one used", async () => {
    const workspace = await mountWorkspace();
    await workspace.actions.setDefaultModel("claude", "opus");

    workspace.actions.openDraft();

    await waitFor(() => expect(workspace.activeTab().kind).toBe("draft"));
    expect(workspace.activeTab().model).toBe("opus");
  });

  it("does not let a per-tab override seed the next tab", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.setTabModel("worktable", "haiku", "read_only");

    workspace.actions.openDraft();

    await waitFor(() => expect(workspace.activeTab().kind).toBe("draft"));
    expect(workspace.activeTab().model).toBe("sonnet");
  });

  /*
   * Disabling a model withdraws it everywhere, not just from the menu. A tab
   * left on a withdrawn model would send the next message under a model the
   * user had just removed.
   */
  it("moves a conflicting project onto the new default", async () => {
    const workspace = await mountWorkspace();
    const onSonnet = () =>
      workspace.state.tabs.filter((tab) => tab.model === "sonnet").map((tab) => tab.key);
    expect(onSonnet().length).toBeGreaterThan(0);

    await workspace.actions.setDefaultModel("claude", "opus");
    await workspace.actions.toggleModel("claude", "sonnet", false);

    expect(onSonnet()).toEqual([]);
    for (const tab of workspace.state.tabs) {
      expect(workspace.state.settings?.models.claude.enabled).toContain(tab.model);
    }
  });

  /*
   * Only the conflicting tabs move. A per-tab override that is still offered is
   * a real choice, and editing an unrelated setting must not quietly reset it.
   */
  it("leaves a tab alone when its model is still offered", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.setTabModel("worktable", "haiku", "read_only");

    await workspace.actions.toggleModel("claude", "fable", true);

    const worktable = workspace.state.tabs.find((tab) => tab.key === "worktable");
    expect(worktable?.model).toBe("haiku");
  });

  it("keeps the prompt menu in step with the withdrawal", async () => {
    const workspace = await mountWorkspace();
    await workspace.actions.setDefaultModel("claude", "opus");
    await workspace.actions.toggleModel("claude", "sonnet", false);

    expect(workspace.promptModels().map((option) => option.value)).not.toContain("sonnet");
  });
});

describe("posture follows Settings too", () => {
  /*
   * Same rule as the model: Settings owns what a new tab starts on. This used to
   * come from `prefs.lastPermission` and had the same shadowing problem.
   */
  it("opens a new tab on the posture Settings names", async () => {
    const workspace = await mountWorkspace();
    await workspace.actions.saveSettings({ defaultPermission: "auto" });

    workspace.actions.openDraft();

    await waitFor(() => expect(workspace.activeTab().kind).toBe("draft"));
    expect(workspace.activeTab().permission).toBe("auto");
  });

  it("does not let a per-tab posture seed the next tab", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.setTabModel("worktable", "sonnet", "bypass");

    workspace.actions.openDraft();

    await waitFor(() => expect(workspace.activeTab().kind).toBe("draft"));
    expect(workspace.activeTab().permission).toBe("read_only");
  });
});
