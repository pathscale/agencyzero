import { render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_STATUS, SETTINGS } from "~/api/fixtures";
import { WelcomeFlow } from "~/features/onboarding/WelcomeFlow";
import { TabStrip } from "~/features/tabs/TabStrip";
import { useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";

async function mountWelcome(): Promise<{
  screen: ReturnType<typeof render>;
  workspace: Workspace;
}> {
  let workspace!: Workspace;

  function Probe() {
    workspace = useWorkspace();
    return null;
  }

  const screen = render(() => (
    <WorkspaceProvider>
      <Probe />
      <TabStrip />
      <WelcomeFlow />
    </WorkspaceProvider>
  ));

  await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });
  return { screen, workspace };
}

afterEach(() => {
  SETTINGS.onboardingCompleted = true;
  AGENT_STATUS.find((status) => status.agent === "claude")!.state = "connected";
  AGENT_STATUS.find((status) => status.agent === "codex")!.state = "logged_out";
  AGENT_STATUS.find((status) => status.agent === "copilot")!.state = "outdated";
});

describe("WelcomeFlow", () => {
  it("stays out of the way for an existing install and reopens from Help", async () => {
    SETTINGS.onboardingCompleted = true;
    const { screen } = await mountWelcome();

    expect(screen.queryByRole("dialog", { name: "Welcome to AgencyZero" })).toBeNull();
    screen.getByRole("button", { name: "Help and setup" }).click();

    expect(await screen.findByRole("dialog", { name: "Welcome to AgencyZero" })).toBeVisible();
    expect(screen.getByText("Restoring from backup?")).toBeVisible();
    expect(screen.getByRole("button", { name: "Select backup file…" })).toBeVisible();
  });

  it("shows on a new store and defers without marking setup complete", async () => {
    SETTINGS.onboardingCompleted = false;
    const { screen, workspace } = await mountWelcome();

    expect(await screen.findByRole("dialog", { name: "Welcome to AgencyZero" })).toBeVisible();
    screen.getByRole("button", { name: "Finish later" }).click();

    await waitFor(() => expect(workspace.state.onboardingDeferred).toBe(true));
    expect(workspace.state.settings?.onboardingCompleted).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Welcome to AgencyZero" })).toBeNull();
  });

  it("allows an explicit skip without pretending prompts will work", async () => {
    SETTINGS.onboardingCompleted = true;
    for (const status of AGENT_STATUS) status.state = "missing";
    const { screen } = await mountWelcome();

    screen.getByRole("button", { name: "Help and setup" }).click();
    const firstContinue = screen.getByRole("button", { name: "Continue" });
    await waitFor(() => expect(firstContinue).toBeEnabled());
    firstContinue.click();

    expect(await screen.findByText("No compatible project agent is ready")).toBeVisible();
    screen.getByRole("button", { name: "Skip - I promise to install them later" }).click();

    expect(await screen.findByText("Agent setup deferred")).toBeVisible();
    expect(screen.getByText("Prompt controls will remain disabled")).toBeVisible();
  });
});
