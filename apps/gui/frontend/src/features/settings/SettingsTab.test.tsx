import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  /*
   * Deep profiling is its own runtime switch. It used to be gated on
   * inspection and cleared whenever inspection went off, so turning inspection
   * off and back on silently dropped it — which is exactly what happened to
   * the owner's setting while driving the running app.
   */
  it("toggles intrusive profiling on its own, with inspection off", async () => {
    const screen = await mountSettings();
    const profiling = (await screen.findByLabelText(
      "Enable deep intrusive profiling",
    )) as HTMLInputElement;
    expect(profiling.disabled).toBe(false);

    fireEvent.click(profiling);
    await waitFor(() =>
      expect(screen.workspace.state.settings?.blitzDeepProfilingEnabled).toBe(true),
    );
    expect(screen.getByText("Intrusive profiling active")).toBeTruthy();

    // And back off again, without inspection ever being involved.
    fireEvent.click(profiling);
    await waitFor(() =>
      expect(screen.workspace.state.settings?.blitzDeepProfilingEnabled).toBe(false),
    );
    expect(screen.getByText("No deep samples collected")).toBeTruthy();
  });

  it("keeps intrusive profiling set while inspection is turned off and on", async () => {
    const screen = await mountSettings();
    const profiling = (await screen.findByLabelText(
      "Enable deep intrusive profiling",
    )) as HTMLInputElement;
    const inspection = await screen.findByLabelText("Enable inspection and agent control");

    fireEvent.click(profiling);
    await waitFor(() =>
      expect(screen.workspace.state.settings?.blitzDeepProfilingEnabled).toBe(true),
    );

    fireEvent.click(inspection);
    await waitFor(() => expect(screen.workspace.state.settings?.blitzControlEnabled).toBe(true));
    fireEvent.click(inspection);
    await waitFor(() => expect(screen.workspace.state.settings?.blitzControlEnabled).toBe(false));

    expect(screen.workspace.state.settings?.blitzDeepProfilingEnabled).toBe(true);
    expect(profiling.checked).toBe(true);
    expect(screen.getByText("Intrusive profiling active")).toBeTruthy();
  });
});

describe("cost warning settings", () => {
  it("renders the application's own slider, not a native range", async () => {
    const screen = await mountSettings();
    const slider = screen.container.querySelector<HTMLElement>('[role="slider"]');
    expect(slider).not.toBeNull();
    if (!slider) throw new Error("the slider thumb was not rendered");
    const root = slider.closest(".az-slider");

    expect(screen.container.querySelector('input[type="range"]')).toBeNull();
    expect(root?.querySelector(".az-slider__track")).toBeTruthy();
    expect(root?.querySelector(".az-slider__fill")).toBeTruthy();
    expect(root?.querySelector(".az-slider__thumb")).toBe(slider);
    expect(slider).toHaveAttribute("aria-label", "Projected turn warning threshold");
    expect(slider).toHaveAttribute("tabindex", "0");
    expect(slider).toHaveAttribute("aria-valuemin", "0.25");
    expect(slider).toHaveAttribute("aria-valuemax", "20");
    expect(slider).toHaveAttribute("aria-valuenow", "0.75");
    expect(slider).toHaveAttribute("aria-valuetext", "$0.75");
    expect(root).toHaveClass("min-w-0");
    expect(root).toHaveClass("w-full");
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

  /*
   * Pressing the track moves the value to the pointer, and the mapping is the
   * inset one: the usable range is the track shrunk by half the thumb at each
   * end, so the extremes stay reachable and the knob never leaves the rail.
   * egui spells it `rect.x_range().shrink(handle_radius)`.
   */
  it("is draggable and persists the pointer-selected threshold", async () => {
    const screen = await mountSettings();
    const track = screen.container.querySelector<HTMLElement>(".az-slider__track");
    const slider = screen.container.querySelector<HTMLElement>('[role="slider"]');
    if (!track || !slider) throw new Error("the slider geometry was not rendered");

    const rect = (width: number) => ({
      value: () => ({
        bottom: 20,
        height: 20,
        left: 0,
        right: width,
        top: 0,
        width,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    // A 200px track with a 20px thumb leaves 180px of travel starting at x=10.
    Object.defineProperty(track, "getBoundingClientRect", rect(200));
    Object.defineProperty(slider, "getBoundingClientRect", rect(20));

    // Halfway along the usable range: 10 + 90 = 100.
    fireEvent.pointerDown(track, { clientX: 100, pointerId: 1 });

    // Pressing previews; the value is shown at once but not yet persisted.
    expect(slider).toHaveAttribute("aria-valuenow", "10.25");
    expect(screen.workspace.state.settings?.costWarningUsd).not.toBe(10.25);

    // Releasing commits. The drag listeners live on the window, because the
    // pointer leaves a 14px knob immediately.
    fireEvent.pointerUp(window);

    expect(slider).toHaveAttribute("aria-valuetext", "$10.25");
    await waitFor(() => expect(screen.workspace.state.settings?.costWarningUsd).toBe(10.25));
  });

  /*
   * One fraction drives both the thumb and the fill, and the inset arithmetic
   * lives in the stylesheet as `fraction * (100% - thumb)`. Nothing is measured
   * in JS to place them, which is what the old percent-plus-offset scheme did.
   */
  it("drives the geometry from a single fraction", async () => {
    const screen = await mountSettings();
    const thumb = screen.container.querySelector<HTMLElement>(".az-slider__thumb");
    const fill = screen.container.querySelector<HTMLElement>(".az-slider__fill");
    if (!thumb || !fill) throw new Error("the slider geometry was not rendered");

    const fraction = (0.75 - 0.25) / (20 - 0.25);
    expect(thumb.style.getPropertyValue("--az-slider-fraction")).toBe(String(fraction));
    expect(fill.style.getPropertyValue("--az-slider-fraction")).toBe(String(fraction));
    expect(thumb.style.getPropertyValue("--az-slider-percent")).toBe("");
  });

  it("does not snap back when an older drag save finishes after a newer value", async () => {
    const screen = await mountSettings();
    const slider = screen.container.querySelector<HTMLElement>('[role="slider"]');
    if (!slider) throw new Error("PathScale slider thumb was not rendered");
    const releases: Array<() => void> = [];
    vi.spyOn(screen.workspace.actions, "saveSettings").mockImplementation(
      () => new Promise<void>((resolve) => releases.push(resolve)),
    );

    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(slider).toHaveAttribute("aria-valuenow", "1.25");
    expect(releases).toHaveLength(2);

    releases[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(slider).toHaveAttribute("aria-valuenow", "1.25");
    releases[1]();
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
    const petals = Array.from(
      screen.container.querySelectorAll<HTMLElement>("[data-surface-petal]"),
    );
    expect(petals).toHaveLength(31);
    expect(new Set(petals.map((petal) => `${petal.style.left}|${petal.style.top}`)).size).toBe(31);
    expect(darkSwatches.every((input) => input.style.left === "" && input.style.top === "")).toBe(
      true,
    );
    expect(
      petals.every((petal) => petal.querySelector('[data-slot="radio-control"]') !== null),
    ).toBe(true);

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

  it("uses the shared PathScale radio hover outline for colour petals", async () => {
    const screen = await mountSettings();
    const petal = screen.container.querySelector<HTMLElement>("[data-surface-petal]");
    const control = petal?.querySelector<HTMLElement>('[data-slot="radio-control"]');
    if (!petal || !control) throw new Error("surface colour petal was not rendered");

    expect(control.parentElement?.className).toContain("border-az-hairline-strong");
    expect(control.parentElement?.className).not.toContain("hovered");
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

describe("diagnostics panel", () => {
  /*
   * Driving the running app, this panel measured 2px tall — its two borders —
   * around 163px of content, so `overflow-hidden` clipped the inspection
   * toggle out of the page. It could be found by search and by nothing else.
   *
   * It is a flex item in the settings column, and `overflow: hidden` zeroes an
   * item's automatic minimum size, so it was the only panel there allowed to
   * shrink and absorbed all of an over-constrained column's shrink. Every
   * Section carries `flex-none` for exactly this reason; this one was
   * hand-rolled and did not.
   *
   * Asserted as a class rather than a height because jsdom lays nothing out: a
   * geometry assertion here would pass against the broken markup too.
   */
  it("keeps the diagnostics panel from shrinking away in the settings column", async () => {
    const screen = await mountSettings();
    const toggle = screen.container.querySelector('[aria-label="Enable inspection and agent control"]');
    expect(toggle).toBeTruthy();

    const panel = toggle?.closest(".overflow-hidden");
    expect(panel).toBeTruthy();
    expect(panel?.className).toContain("flex-none");
  });
});

describe("store snapshot", () => {
  /*
   * Manual, and only manual. This ran on every launch, which cost a full copy
   * of the store per boot and left ten copies in one profile — while the
   * corruption that actually happened was copied faithfully into both rolling
   * snapshots, so neither could restore past it.
   */
  it("offers a snapshot button and takes one on demand", async () => {
    const screen = await mountSettings();
    const button = await screen.findByRole("button", { name: "Take snapshot" });
    expect(button).toBeTruthy();

    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText(/Written to/)).toBeTruthy());
  });
});
