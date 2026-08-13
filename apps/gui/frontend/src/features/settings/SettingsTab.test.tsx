import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it } from "vitest";
import { setMockProxyActiveRuns } from "~/api/mock";
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

beforeEach(() => setMockProxyActiveRuns(0));

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
    const picker = await screen.findByLabelText("Choose a session from Claude Code");

    expect(picker.classList).toContain("h-9");
    fireEvent.click(picker);
    await waitFor(() => expect(document.body.querySelector('[role="listbox"]')).not.toBeNull());
    const offered = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).map(
      (option) => option.getAttribute("data-key"),
    );
    expect(offered).not.toContain("cloud-only");
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

describe("AgencyProxy lifecycle", () => {
  it("keeps an idle stop down until the owner starts it", async () => {
    const screen = await mountSettings();
    const stop = await screen.findByRole("button", { name: "Stop" });

    expect(screen.getByText("(fixture endpoint)")).toBeTruthy();

    fireEvent.click(stop);
    await waitFor(() => expect(screen.getByText("AgencyProxy stopped")).toBeTruthy());
    expect(screen.workspace.state.agencyProxy?.connected).toBe(false);

    const start = screen.getByRole("button", { name: "Start" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() => expect(screen.getByText("AgencyProxy started")).toBeTruthy());
    expect(screen.workspace.state.agencyProxy?.connected).toBe(true);
  });

  it("offers graceful Stop during a live run and explains the wait", async () => {
    setMockProxyActiveRuns(1);
    const screen = await mountSettings();
    const stop = await screen.findByRole("button", { name: "Stop" });

    fireEvent.click(stop);
    expect(screen.getByText("Waiting for 1 live run to finish")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("AgencyProxy stopped")).toBeTruthy());
  });
});

describe("local debug control", () => {
  it("shows whether the local MCP socket is listening", async () => {
    const screen = await mountSettings();
    const toggle = (await screen.findByLabelText(
      "Enable inspection and agent control",
    )) as HTMLInputElement;

    expect(toggle.checked).toBe(false);
    expect(screen.getByText("Inspection and control disabled")).toBeTruthy();

    fireEvent.click(toggle);

    await waitFor(() => expect(screen.workspace.state.settings?.blitzControlEnabled).toBe(true));
    await waitFor(() => expect(screen.getByText("Listening on local MCP socket")).toBeTruthy());
  });

  it("keeps intrusive profiling unavailable until inspection is enabled", async () => {
    const screen = await mountSettings();
    const profiling = (await screen.findByLabelText(
      "Enable deep intrusive profiling",
    )) as HTMLInputElement;
    expect(profiling.disabled).toBe(true);
    expect(screen.getByText("Enable inspection first")).toBeTruthy();

    fireEvent.click(await screen.findByLabelText("Enable inspection and agent control"));
    await waitFor(() => expect(profiling.disabled).toBe(false));
    fireEvent.click(profiling);
    await waitFor(() =>
      expect(screen.workspace.state.settings?.blitzDeepProfilingEnabled).toBe(true),
    );
    expect(screen.getByText("Intrusive profiling active")).toBeTruthy();

    fireEvent.click(await screen.findByLabelText("Enable inspection and agent control"));
    expect(profiling.checked).toBe(false);
    expect(profiling.disabled).toBe(true);
    expect(screen.getByText("Enable inspection first")).toBeTruthy();
    await waitFor(() => expect(screen.workspace.state.settings?.blitzControlEnabled).toBe(false));
    expect(screen.workspace.state.settings?.blitzDeepProfilingEnabled).toBe(false);
    expect(profiling.disabled).toBe(true);
  });
});

describe("cost warning settings", () => {
  it("renders the PathScale slider track and thumb instead of a disappearing native range", async () => {
    const screen = await mountSettings();
    const slider = screen.container.querySelector<HTMLElement>('[role="slider"]');
    expect(slider).not.toBeNull();
    if (!slider) throw new Error("PathScale slider thumb was not rendered");
    const root = slider.closest('[data-slot="slider"]');
    const labelId = slider.getAttribute("aria-labelledby");

    expect(screen.container.querySelector('input[type="range"]')).toBeNull();
    expect(root?.querySelector('[data-slot="slider-track"]')).toBeTruthy();
    expect(root?.querySelector('[data-slot="slider-fill"]')).toBeTruthy();
    expect(root?.querySelector('[data-slot="slider-thumb"]')).toBe(slider);
    expect(labelId).toBeTruthy();
    expect(screen.container.querySelector(`#${labelId}`)?.textContent).toBe(
      "Projected turn warning threshold",
    );
    expect(slider).toHaveAttribute("tabindex", "0");
    expect(slider).toHaveAttribute("aria-valuemin", "0.25");
    expect(slider).toHaveAttribute("aria-valuemax", "20");
    expect(slider).toHaveAttribute("aria-valuenow", "0.75");
    expect(slider).toHaveAttribute("aria-valuetext", "$0.75");
  });

  it("is keyboard-operable and persists the selected threshold", async () => {
    const screen = await mountSettings();
    const slider = screen.container.querySelector<HTMLElement>('[role="slider"]');
    expect(slider).not.toBeNull();
    if (!slider) throw new Error("PathScale slider thumb was not rendered");

    fireEvent.keyDown(slider, { key: "ArrowRight" });

    expect(slider).toHaveAttribute("aria-valuenow", "1");
    expect(slider).toHaveAttribute("aria-valuetext", "$1.00");
    await waitFor(() => expect(screen.workspace.state.settings?.costWarningUsd).toBe(1));
  });

  it("is draggable and persists the pointer-selected threshold", async () => {
    const screen = await mountSettings();
    const track = screen.container.querySelector<HTMLElement>('[data-slot="slider-track"]');
    const slider = screen.container.querySelector<HTMLElement>('[role="slider"]');
    expect(track).not.toBeNull();
    expect(slider).not.toBeNull();
    if (!track || !slider) throw new Error("PathScale slider geometry was not rendered");

    Object.defineProperty(track, "getBoundingClientRect", {
      value: () => ({
        bottom: 20,
        height: 20,
        left: 0,
        right: 200,
        top: 0,
        width: 200,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    Object.defineProperty(track, "setPointerCapture", { value: () => {} });

    fireEvent.pointerDown(track, { clientX: 100, pointerId: 1 });

    expect(slider).toHaveAttribute("aria-valuenow", "10.25");
    expect(slider).toHaveAttribute("aria-valuetext", "$10.25");
    await waitFor(() => expect(screen.workspace.state.settings?.costWarningUsd).toBe(10.25));
  });
});

describe("moderator settings", () => {
  it("offers every selected provider model", async () => {
    const screen = await mountSettings();

    fireEvent.click(screen.getByLabelText("Moderator model"));

    await waitFor(() => expect(document.body.textContent).toContain("Codex · GPT-5.6-Sol"));
    expect(document.body.textContent).toContain("Claude · Haiku");
    expect(document.body.textContent).toContain("Copilot · Auto");
  });
});

describe("appearance settings", () => {
  it("stores the literal dark wheel value and rebases the same petal in light mode", async () => {
    const screen = await mountSettings();
    const darkSwatches = Array.from(
      screen.container.querySelectorAll<HTMLInputElement>('input[name="surface-colour"]'),
    );
    expect(darkSwatches).toHaveLength(31);

    const darkHex = darkSwatches[0].value;
    fireEvent.click(darkSwatches[0]);
    await waitFor(() => expect(screen.workspace.state.settings?.theme.surface).toBe(darkHex));
    expect(darkSwatches[0].checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    await waitFor(() => expect(screen.workspace.state.settings?.theme.surface).not.toBe(darkHex));
    expect(
      Array.from(
        screen.container.querySelectorAll<HTMLInputElement>('input[name="surface-colour"]'),
      ).some((input) => input.checked),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
  });

  it("offers curated accents without opening a colour input", async () => {
    const screen = await mountSettings();

    expect(screen.workspace.state.settings?.theme.surface).toBe("");
    expect(screen.workspace.state.settings?.theme.accent).toBe("");
    expect(screen.container.querySelector('input[type="color"]')).toBeNull();
    expect(
      screen.container.querySelectorAll(
        'button[aria-label^="Accent colour"], button[aria-label="Designed yellow accent"]',
      ),
    ).toHaveLength(7);
    fireEvent.click(
      screen.container.querySelector('button[aria-label="Accent colour 2"]') as HTMLButtonElement,
    );

    await waitFor(() => expect(screen.workspace.state.settings?.theme.accent).not.toBe(""));
    expect(screen.workspace.state.settings?.theme.surface).toBe("");
    const initialAccent = screen.workspace.state.settings?.theme.accent;

    expect(
      screen.container.querySelector('button[aria-label="Colour strength 30%"]'),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.container.querySelector('button[aria-label="Colour strength 0%"]')).toBeNull();
    fireEvent.click(
      screen.container.querySelector(
        'button[aria-label="Colour strength 20%"]',
      ) as HTMLButtonElement,
    );
    await waitFor(() =>
      expect(screen.workspace.state.settings?.theme.accent).not.toBe(initialAccent),
    );

    fireEvent.click(
      screen.container.querySelector('button[aria-label="Reset to default"]') as HTMLButtonElement,
    );
    await waitFor(() => expect(screen.workspace.state.settings?.theme.accent).toBe(""));
    expect(screen.workspace.state.settings?.theme.wash).toBe(30);
  });
});

describe("open source actions", () => {
  it("offers source and star actions without interrupting the owner", async () => {
    const screen = await mountSettings();
    expect(screen.getByRole("button", { name: "View source" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Star on GitHub" })).toBeTruthy();
    expect(
      screen.getByText("If AgencyZero is useful, a GitHub star helps more people find it."),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: /star/i })).toBeNull();
  });
});
