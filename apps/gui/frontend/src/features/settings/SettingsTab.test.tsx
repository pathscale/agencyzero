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
    expect(Array.from(picker.options).map((option) => option.value)).not.toContain("cloud-only");
    fireEvent.click(screen.getByRole("button", { name: "Import all" }));

    await waitFor(() => expect(screen.getByText("Imported 2 chats from Claude Code")).toBeTruthy());
  });
});

describe("store backups", () => {
  it("requires a native backup selection before offering restore", async () => {
    const screen = await mountSettings();

    await waitFor(() => expect(screen.getByText(/Portable .azbackup package/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Back up & close" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Select backup file…" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  });
});

describe("cost warning settings", () => {
  it("persists a per-turn warning threshold across the full slider range", async () => {
    const screen = await mountSettings();
    const slider = screen.getByLabelText("Projected turn warning threshold") as HTMLInputElement;

    expect(slider.min).toBe("0.25");
    expect(slider.max).toBe("20");
    expect(slider.value).toBe("0.75");

    fireEvent.change(slider, { target: { value: "1.25" } });
    await waitFor(() => expect(screen.workspace.state.settings?.costWarningUsd).toBe(1.25));
  });
});

describe("appearance settings", () => {
  it("offers curated accents without opening a colour input", async () => {
    const screen = await mountSettings();

    expect(screen.workspace.state.settings?.theme.surface).toBe("");
    expect(screen.workspace.state.settings?.theme.accent).toBe("");
    expect(screen.container.querySelector('input[type="color"]')).toBeNull();
    expect(screen.getAllByRole("button", { name: /accent/i })).toHaveLength(7);
    fireEvent.click(screen.getByRole("button", { name: "Accent colour 2" }));

    await waitFor(() => expect(screen.workspace.state.settings?.theme.accent).not.toBe(""));
    expect(screen.workspace.state.settings?.theme.surface).toBe("");
    const initialAccent = screen.workspace.state.settings?.theme.accent;

    fireEvent.click(screen.getByRole("button", { name: "Colour strength 100%" }));
    await waitFor(() =>
      expect(screen.workspace.state.settings?.theme.accent).not.toBe(initialAccent),
    );
  });
});
