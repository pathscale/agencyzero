import { render, waitFor } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { beforeEach, describe, expect, it } from "vitest";
import { setPrefs } from "~/stores/prefs";
import { useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";

/**
 * Mounts the provider against the mock, which serves the same catalogues the
 * crate compiles in: nine Claude aliases plus AgencyZero's pinned 4.8 supplement
 * and four crate pinned ids, six Codex models,
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

// Boot restores only remembered tabs now; these scenarios want them all open.
beforeEach(() => {
  setPrefs((d) => {
    d.openTabKeys = ["worktable", "cafe", "quux"];
  });
});

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

  it("offers Claude Opus 4.8 as an exact pinned model", async () => {
    const workspace = await mountWorkspace();
    const model = workspace.state.models
      .find((entry) => entry.agent === "claude")
      ?.models.find((entry) => entry.id === "claude-opus-4-8");

    expect(model?.name).toBe("Claude Opus 4.8");
    expect(model?.kind).toBe("pinned");
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
      "opus[1m]",
      "sonnet[1m]",
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
    for (const id of ["default", "opus", "haiku", "opus[1m]", "sonnet[1m]"]) {
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
  it("offers the enabled Claude and OpenAI models, in catalogue order", async () => {
    const workspace = await mountWorkspace();
    expect(workspace.promptModels().map((option) => option.value)).toEqual([
      "claude:default",
      "claude:opus",
      "claude:sonnet",
      "claude:haiku",
      "claude:opus[1m]",
      "claude:sonnet[1m]",
      "codex:gpt-5.6-sol",
      "codex:gpt-5.6-terra",
      "codex:gpt-5.6-luna",
      "codex:gpt-5.5",
    ]);
  });

  it("moves the moderator to another selected model when its model is removed", async () => {
    const workspace = await mountWorkspace();
    await workspace.actions.saveSettings({ moderator: { model: "codex:gpt-5.6-sol" } });

    await workspace.actions.toggleModel("codex", "gpt-5.6-sol", false);

    expect(workspace.state.settings?.moderator.model).toBe("codex:gpt-5.6-terra");
  });

  /** The pill names both provider and model so a mixed list stays legible. */
  it("labels options with their provider and display name", async () => {
    const workspace = await mountWorkspace();
    const sonnet = workspace.promptModels().find((option) => option.value === "claude:sonnet");
    const sol = workspace.promptModels().find((option) => option.value === "codex:gpt-5.6-sol");
    expect(sonnet?.label).toBe("Claude · Sonnet");
    expect(sol?.label).toBe("OpenAI · GPT-5.6-Sol");
  });

  it("follows the selection as it changes", async () => {
    const workspace = await mountWorkspace();
    await workspace.actions.toggleModel("claude", "haiku", false);

    expect(workspace.promptModels().map((option) => option.value)).not.toContain("claude:haiku");
  });

  it("does not offer Copilot yet", async () => {
    const workspace = await mountWorkspace();
    await workspace.actions.toggleModel("codex", "gpt-5.4", true);
    await workspace.actions.toggleModel("copilot", "gemini-3.6-flash", true);

    const offered = workspace.promptModels().map((option) => option.value);
    expect(offered).toContain("codex:gpt-5.4");
    expect(offered).not.toContain("copilot:gemini-3.6-flash");
  });

  it("sends an OpenAI selection through the Codex agent", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.setTabModel("worktable", "codex", "gpt-5.6-sol", "read_only");
    flush();

    await workspace.actions.send("worktable", "Use OpenAI for this turn");

    const sent = workspace.state.messages.worktable.at(-1);
    expect(sent?.agent).toBe("codex");
    expect(sent?.model).toBe("gpt-5.6-sol");
  });

  it("keeps Ask when switching to an approval-capable OpenAI model", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.setTabModel("worktable", "claude", "sonnet", "ask");
    workspace.actions.setTabModel("worktable", "codex", "gpt-5.6-sol", "ask");
    flush();

    const tab = workspace.state.tabs.find((candidate) => candidate.key === "worktable");
    expect(tab?.agent).toBe("codex");
    expect(tab?.permission).toBe("ask");
  });

  it("restores the last provider when a project is closed and reopened", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.setTabModel("worktable", "codex", "gpt-5.6-sol", "auto");
    flush();
    await workspace.actions.send("worktable", "Keep this project on OpenAI");

    workspace.actions.closeTab("worktable");
    workspace.actions.openProject("worktable");
    flush();

    const tab = workspace.state.tabs.find((candidate) => candidate.key === "worktable");
    expect(tab?.agent).toBe("codex");
    expect(tab?.model).toBe("gpt-5.6-sol");
    expect(tab?.permission).toBe("auto");
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
    workspace.actions.setTabModel("worktable", "claude", "haiku", "read_only");
    flush();

    workspace.actions.openDraft();

    await waitFor(() => expect(workspace.activeTab().kind).toBe("draft"));
    expect(workspace.activeTab().model).toBe("sonnet");
  });

  /*
   * Disabling a model withdraws it from the menu, and a tab already on it keeps
   * it.
   *
   * This used to move every conflicting tab onto the new default, so that no
   * tab could send under a model that had just been removed. The concern was
   * right and the remedy was not: the swap was silent, and a tab whose agent
   * differed from the default changed vendor too, so withdrawing a Codex model
   * could hand a Codex project to Claude. A pick is binding. The composer
   * refuses to send a withdrawn model and names it, which is where that failure
   * belongs, so the tab can hold the real choice until the owner replaces it.
   */
  it("leaves a project on a withdrawn model rather than swapping it", async () => {
    const workspace = await mountWorkspace();
    const onSonnet = () =>
      workspace.state.tabs.filter((tab) => tab.model === "sonnet").map((tab) => tab.key);
    const before = onSonnet();
    expect(before.length).toBeGreaterThan(0);

    await workspace.actions.setDefaultModel("claude", "opus");
    await workspace.actions.toggleModel("claude", "sonnet", false);

    // Still there, and still on the model that was picked.
    expect(onSonnet()).toEqual(before);
    expect(workspace.state.settings?.models.claude.enabled).not.toContain("sonnet");
  });

  /*
   * The vendor half, stated separately because it is the worse failure: a
   * settings edit that names no agent must never change which company receives
   * the prompt.
   */
  it("never changes a tab's agent when its model is withdrawn", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.setTabModel("worktable", "codex", "gpt-5.6-sol", "read_only");
    flush();

    await workspace.actions.toggleModel("codex", "gpt-5.6-sol", false);

    const worktable = () => workspace.state.tabs.find((tab) => tab.key === "worktable");
    await waitFor(() => expect(worktable()?.agent).toBe("codex"));
    expect(worktable()?.model).toBe("gpt-5.6-sol");
  });

  /*
   * Only the conflicting tabs move. A per-tab override that is still offered is
   * a real choice, and editing an unrelated setting must not quietly reset it.
   */
  it("leaves a tab alone when its model is still offered", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.setTabModel("worktable", "claude", "haiku", "read_only");
    flush();

    await workspace.actions.toggleModel("claude", "fable", true);

    const worktable = workspace.state.tabs.find((tab) => tab.key === "worktable");
    expect(worktable?.model).toBe("haiku");
  });

  it("keeps the prompt menu in step with the withdrawal", async () => {
    const workspace = await mountWorkspace();
    await workspace.actions.setDefaultModel("claude", "opus");
    await workspace.actions.toggleModel("claude", "sonnet", false);

    expect(workspace.promptModels().map((option) => option.value)).not.toContain("claude:sonnet");
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
    workspace.actions.setTabModel("worktable", "claude", "sonnet", "bypass");
    flush();

    workspace.actions.openDraft();

    await waitFor(() => expect(workspace.activeTab().kind).toBe("draft"));
    expect(workspace.activeTab().permission).toBe("read_only");
  });

  it("opens a Codex draft with Ask when Settings says Ask", async () => {
    const workspace = await mountWorkspace();
    await workspace.actions.saveSettings({ defaultAgent: "codex", defaultPermission: "ask" });

    workspace.actions.openDraft();

    await waitFor(() => expect(workspace.activeTab().kind).toBe("draft"));
    expect(workspace.activeTab().agent).toBe("codex");
    expect(workspace.activeTab().permission).toBe("ask");
  });

  it("keeps Copilot out of project tabs until project runs support it", async () => {
    const workspace = await mountWorkspace();
    await workspace.actions.saveSettings({ defaultAgent: "copilot" });

    workspace.actions.openDraft();

    await waitFor(() => expect(workspace.activeTab().kind).toBe("draft"));
    expect(workspace.activeTab().agent).toBe("claude");
    expect(workspace.activeTab().model).toBe("sonnet");
  });
});

describe("an open draft tracks the defaults", () => {
  /*
   * The reported bug: `openDraft` focuses an existing draft rather than making a
   * new one, so a draft opened before a settings change kept the old defaults
   * and the setting looked ignored.
   */
  it("moves an open draft onto a newly chosen model", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.openDraft();
    await waitFor(() => expect(workspace.activeTab().kind).toBe("draft"));
    expect(workspace.activeTab().model).toBe("sonnet");

    await workspace.actions.setDefaultModel("claude", "opus");

    expect(workspace.activeTab().model).toBe("opus");
  });

  it("moves an open draft onto a newly chosen posture", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.openDraft();
    await waitFor(() => expect(workspace.activeTab().kind).toBe("draft"));

    await workspace.actions.saveSettings({ defaultPermission: "auto" });

    expect(workspace.activeTab().permission).toBe("auto");
  });

  it("moves an open draft onto a newly chosen effort", async () => {
    const workspace = await mountWorkspace();
    workspace.actions.openDraft();
    await waitFor(() => expect(workspace.activeTab().kind).toBe("draft"));

    await workspace.actions.saveSettings({ defaultEffort: "max" });

    expect(workspace.activeTab().effort).toBe("max");
  });

  /*
   * A project has history and its own choice. Only a withdrawn model moves it,
   * which is the rule a draft deliberately does not follow.
   */
  it("leaves a project's posture alone when the default changes", async () => {
    const workspace = await mountWorkspace();
    const before = workspace.state.tabs.find((tab) => tab.key === "worktable")?.permission;

    await workspace.actions.saveSettings({ defaultPermission: "bypass" });

    expect(workspace.state.tabs.find((tab) => tab.key === "worktable")?.permission).toBe(before);
  });
});
