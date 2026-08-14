import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_STATUS, SETTINGS } from "~/api/fixtures";
import { WelcomeFlow } from "~/features/onboarding/WelcomeFlow";
import { SettingsTab } from "~/features/settings/SettingsTab";
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
      <SettingsTab />
      <WelcomeFlow />
    </WorkspaceProvider>
  ));

  await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });
  return { screen, workspace };
}

function welcomeDialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(
    '[data-slot="dialog-content"][aria-labelledby="welcome-title"]',
  );
}

function modalButton(dialog: HTMLElement, name: string): HTMLButtonElement {
  const button = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) =>
      candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );
  if (!button) throw new Error(`Could not find modal button: ${name}`);
  return button;
}

afterEach(() => {
  SETTINGS.onboardingCompleted = true;
  AGENT_STATUS.find((status) => status.agent === "claude")!.state = "connected";
  AGENT_STATUS.find((status) => status.agent === "codex")!.state = "logged_out";
  AGENT_STATUS.find((status) => status.agent === "copilot")!.state = "outdated";
});

describe("WelcomeFlow", () => {
  it("stays out of the way for an existing install and reopens from Settings", async () => {
    SETTINGS.onboardingCompleted = true;
    const { screen } = await mountWelcome();

    expect(welcomeDialog()).toBeNull();
    expect(screen.queryByRole("button", { name: "Help and setup" })).toBeNull();
    screen.getByRole("button", { name: "Welcome Tutorial" }).click();

    await waitFor(() => expect(welcomeDialog()).not.toBeNull());
    const dialog = welcomeDialog()!;
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.querySelector("#welcome-title")).toHaveTextContent("Welcome to AgencyZero");
    expect(dialog).toHaveTextContent("Restoring from backup?");
    expect(modalButton(dialog, "Select backup file…")).toBeVisible();
  });

  it("remains open until an explicit tutorial action closes it", async () => {
    SETTINGS.onboardingCompleted = true;
    const { screen } = await mountWelcome();

    screen.getByRole("button", { name: "Welcome Tutorial" }).click();
    await waitFor(() => expect(welcomeDialog()).not.toBeNull());
    const backdrop = document.body.querySelector<HTMLElement>('[data-slot="dialog-backdrop"]');
    expect(backdrop).not.toBeNull();
    if (!backdrop) throw new Error("Welcome backdrop was not rendered");

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(backdrop);
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(welcomeDialog()).not.toBeNull();
    fireEvent.click(modalButton(welcomeDialog()!, "Close setup"));
    await waitFor(() => expect(welcomeDialog()).toBeNull());
  });

  it("shows on a new store and defers without marking setup complete", async () => {
    SETTINGS.onboardingCompleted = false;
    const { workspace } = await mountWelcome();

    await waitFor(() => expect(welcomeDialog()).not.toBeNull());
    fireEvent.click(modalButton(welcomeDialog()!, "Finish later"));

    await waitFor(() => expect(workspace.state.onboardingDeferred).toBe(true));
    expect(workspace.state.settings?.onboardingCompleted).toBe(false);
    expect(welcomeDialog()).toBeNull();
  });

  it("allows an explicit skip without pretending prompts will work", async () => {
    SETTINGS.onboardingCompleted = true;
    for (const status of AGENT_STATUS) status.state = "missing";
    const { screen } = await mountWelcome();

    screen.getByRole("button", { name: "Welcome Tutorial" }).click();
    await waitFor(() => expect(welcomeDialog()).not.toBeNull());
    const firstContinue = modalButton(welcomeDialog()!, "Continue");
    await waitFor(() => expect(firstContinue).toBeEnabled());
    fireEvent.click(firstContinue);

    await waitFor(() =>
      expect(welcomeDialog()).toHaveTextContent("No compatible project agent is ready"),
    );
    fireEvent.click(modalButton(welcomeDialog()!, "Skip - I promise to install them later"));

    await waitFor(() => expect(welcomeDialog()).toHaveTextContent("Agent setup deferred"));
    expect(welcomeDialog()).toHaveTextContent("Prompt controls will remain disabled");
  });
});
