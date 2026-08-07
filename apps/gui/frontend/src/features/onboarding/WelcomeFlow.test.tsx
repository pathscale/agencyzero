import { render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { SETTINGS } from "~/api/fixtures";
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
});
