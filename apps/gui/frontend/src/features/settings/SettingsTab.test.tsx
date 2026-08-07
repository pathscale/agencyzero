import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { SettingsTab } from "~/features/settings/SettingsTab";
import { useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";

async function mountSettings() {
  let workspace!: Workspace;

  function Probe() {
    workspace = useWorkspace();
    return null;
  }

  const screen = render(() => (
    <WorkspaceProvider>
      <Probe />
      <SettingsTab />
    </WorkspaceProvider>
  ));

  await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });
  await waitFor(() => expect(screen.getByText("no study interval has been started")).toBeTruthy());
  return { ...screen, workspace };
}

describe("PS deployment study settings", () => {
  it("starts off and explains the content boundary", async () => {
    const screen = await mountSettings();
    const toggle = screen.getByLabelText("PS deployment study") as HTMLInputElement;

    expect(toggle.checked).toBe(false);
    expect(screen.getByText(/does not copy prompt text/)).toBeTruthy();
    expect(screen.getByText(/Nothing is uploaded/)).toBeTruthy();
  });

  it("creates a study interval only after explicit opt-in", async () => {
    const screen = await mountSettings();
    const toggle = screen.getByLabelText("PS deployment study") as HTMLInputElement;

    fireEvent.click(toggle);

    await waitFor(() => expect(toggle.checked).toBe(true));
    await waitFor(() => expect(screen.getByText("Collection started locally.")).toBeTruthy());
    expect(screen.workspace.state.settings?.studyAnalytics.sessionId).toMatch(/^study-/);
    expect(screen.workspace.state.settings?.studyAnalytics.enabledAt).not.toBe("");
  });

  it("requires a second action before deleting local study rows", async () => {
    const screen = await mountSettings();
    const toggle = screen.getByLabelText("PS deployment study") as HTMLInputElement;
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("Collection started locally.")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Delete data" })).toBeDisabled();

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("Collection stopped.")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Delete data" }));
    expect(screen.getByRole("button", { name: "Confirm delete" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() =>
      expect(
        screen.getByText("Stored study events deleted. The collection setting was not changed."),
      ).toBeTruthy(),
    );
    expect(toggle.checked).toBe(false);
  });
});

describe("chat imports", () => {
  it("offers a taller session picker and imports every session from one source", async () => {
    const screen = await mountSettings();
    const picker = (await screen.findByLabelText(
      "Choose a session from Claude Code",
    )) as HTMLSelectElement;

    expect(picker.classList).toContain("h-9");
    fireEvent.click(screen.getByRole("button", { name: "Import all" }));

    await waitFor(() => expect(screen.getByText("Imported 2 chats from Claude Code")).toBeTruthy());
  });
});
