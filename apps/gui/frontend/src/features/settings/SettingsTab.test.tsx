import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMockProxyActiveRuns } from "~/api/mock";
import { SettingsTab } from "~/features/settings/SettingsTab";
import { record as perfRecord, reset as perfReset } from "~/lib/perf";
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

  /*
   * The switch has to move on the click, not when the store answers.
   *
   * Both cases above assert after `waitFor`, so they only ever look once the
   * write has landed — and the failure lives entirely in the window before
   * that. Rendering `settings()` directly left the toggle in its old position
   * for the whole round trip, and the control was disabled meanwhile, so a
   * second click was swallowed rather than queued. On the running app that
   * reads as a switch that flickers and will not stay on.
   *
   * So this samples *across* the write rather than after it, the same way
   * `sliderAudit` samples a slider mid-release.
   */
  it("shows intrusive profiling on immediately, before the write lands", async () => {
    const screen = await mountSettings();
    const profiling = (await screen.findByLabelText(
      "Enable deep intrusive profiling",
    )) as HTMLInputElement;

    fireEvent.click(profiling);

    // Same tick as the click: the store has not answered yet.
    expect(screen.workspace.state.settings?.blitzDeepProfilingEnabled).not.toBe(true);
    expect(profiling.checked).toBe(true);
    expect(screen.getByText("Intrusive profiling active")).toBeTruthy();
    // And it must stay usable, so a second click is not dropped on the floor.
    expect(profiling.disabled).toBe(false);

    await waitFor(() =>
      expect(screen.workspace.state.settings?.blitzDeepProfilingEnabled).toBe(true),
    );
    expect(profiling.checked).toBe(true);
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
  it("renders the library slider, not a native range", async () => {
    const screen = await mountSettings();
    const slider = screen.container.querySelector<HTMLElement>('[role="slider"]');
    expect(slider).not.toBeNull();
    if (!slider) throw new Error("the slider thumb was not rendered");
    const root = slider.closest('[data-slot="slider"]');
    const labelId = slider.getAttribute("aria-labelledby");

    expect(screen.container.querySelector('input[type="range"]')).toBeNull();
    expect(root?.querySelector('[data-slot="slider-track"]')).toBeTruthy();
    expect(root?.querySelector('[data-slot="slider-fill"]')).toBeTruthy();
    expect(root?.querySelector('[data-slot="slider-thumb"]')).toBe(slider);
    expect(screen.container.querySelector(`#${labelId}`)?.textContent).toBe(
      "Projected turn warning threshold",
    );
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

    // Releasing the key ends the keyboard interaction, which is what persists:
    // the library raises `onChangeEnd` from `keyup` and `blur`, so holding an
    // arrow down repeats the preview without repeating the store write.
    fireEvent.keyUp(slider, { key: "ArrowRight" });
    await waitFor(() => expect(screen.workspace.state.settings?.costWarningUsd).toBe(1));
  });

  /*
   * The installed @pathscale/ui maps the pointer across the full track width.
   * That disagrees with where it draws the thumb, whose centre travels an inset
   * range; the fix is committed in the library and arrives with 2.0.0. This
   * asserts what this version actually does, so the upgrade will show up here
   * as a failure rather than as a surprise.
   */
  it("is draggable and persists the pointer-selected threshold", async () => {
    const screen = await mountSettings();
    const track = screen.container.querySelector<HTMLElement>('[data-slot="slider-track"]');
    const slider = screen.container.querySelector<HTMLElement>('[role="slider"]');
    if (!track || !slider) throw new Error("the slider geometry was not rendered");

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

    // Shown at once, and not yet written: the store round trip belongs to the
    // release, so a drag cannot queue one serialized write per tick.
    expect(slider).toHaveAttribute("aria-valuenow", "10.25");
    expect(slider).toHaveAttribute("aria-valuetext", "$10.25");
    expect(screen.workspace.state.settings?.costWarningUsd).not.toBe(10.25);

    // Releasing is what persists. The drag has to be finished for the value to
    // reach the store at all, which is the whole point of `onChangeEnd`.
    fireEvent.pointerUp(track, { clientX: 100, pointerId: 1 });

    await waitFor(() => expect(screen.workspace.state.settings?.costWarningUsd).toBe(10.25), {
      timeout: 2000,
    });
  });

  /*
   * The thumb's centre travels a range inset by half the knob plus the track
   * padding, so it rides the rail instead of hanging off either end. That
   * arithmetic is the library's, in the `left` it writes; this asserts the app
   * is not second-guessing it with geometry of its own, which is what three
   * rounds of `!important` overrides had been doing.
   */
  it("leaves the thumb geometry to the library", async () => {
    const screen = await mountSettings();
    const thumb = screen.container.querySelector<HTMLElement>('[data-slot="slider-thumb"]');
    if (!thumb) throw new Error("the slider geometry was not rendered");

    expect(thumb.style.left).toContain("var(--slider-thumb-w)");
    expect(thumb.style.left).toContain("var(--slider-pad)");
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

    // Two steps inside one keypress-and-release. The display follows each at
    // once; the store write belongs to the release, so this is one save and
    // not two.
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(slider).toHaveAttribute("aria-valuenow", "1.25");
    expect(releases).toHaveLength(0);

    fireEvent.keyUp(slider, { key: "ArrowRight" });
    await waitFor(() => expect(releases).toHaveLength(1), { timeout: 2000 });

    // The preview is held until the save it belongs to lands, so a slow write
    // finishing late cannot pull the display back to a value already left.
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(slider).toHaveAttribute("aria-valuenow", "1.5");
    releases[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(slider).toHaveAttribute("aria-valuenow", "1.5");
  });
});

/*
 * The whole Settings tab is mounted at boot and merely hidden with a class, so
 * this component runs once. Its table would otherwise freeze at whatever had
 * been measured by the time boot finished, which is exactly what it did: five
 * project loads and nothing that happened afterwards, however much the app was
 * used between then and looking at it.
 */
describe("internal performance table", () => {
  it("re-reads the measurements when Settings comes to the front", async () => {
    const screen = await mountSettings();

    perfReset();
    perfRecord("something measured after this mounted", 12.5);
    expect(screen.queryByText("something measured after this mounted")).toBeNull();

    // Leaving and coming back is the moment the numbers are wanted.
    screen.workspace.actions.focus("home");
    screen.workspace.actions.openSettings();

    await waitFor(() =>
      expect(screen.getByText("something measured after this mounted")).toBeTruthy(),
    );
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

  /*
   * The petal is styled through the class the library renders.
   *
   * This used to reach for `[data-slot="radio-control"]` and assert that the
   * *class string* carried `border-az-hairline-strong`. Both halves were empty:
   * `@pathscale/ui` emits no `data-slot` attribute anywhere in its radio, and a
   * utility sitting in a string is not a utility that applies to anything. The
   * live app showed the cost — 31 petals kept the library's own 1rem control
   * where `size-7` asks for 28, and no hover feedback at all.
   *
   * So what is asserted now is the hook the stylesheet actually uses. The
   * geometry and the hover lift belong to `theme.css` and are guarded there;
   * jsdom applies no stylesheet, so asserting them here would only re-test a
   * string.
   */
  it("hooks colour petals up to the class the library renders", async () => {
    const screen = await mountSettings();
    const petal = screen.container.querySelector<HTMLElement>("[data-surface-petal]");
    const radio = petal?.querySelector<HTMLElement>(".radio");
    if (!petal || !radio) throw new Error("surface colour petal was not rendered");

    expect(radio.className).toContain("az-petal");
    expect(radio.querySelector(".radio__control")).not.toBeNull();
    // The swatch lives in the indicator, which is why the library's own
    // `:empty::before` hover tint can never reach a petal.
    expect(radio.querySelector(".radio__indicator")?.children.length).toBeGreaterThan(0);
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
    const toggle = screen.container.querySelector(
      '[aria-label="Enable inspection and agent control"]',
    );
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
