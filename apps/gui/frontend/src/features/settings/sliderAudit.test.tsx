import { flush } from "solid-js";
/**
 * Every slider in Settings renders, and every one of them moves.
 *
 * This file exists because sliders in this app have shipped broken three
 * separate times, each for a different reason and none caught by a test:
 *
 * 1. The engine had no `offsetWidth`, so the library's inset arithmetic was
 *    `NaN` and every drag snapped to `NaN`. Nothing threw. The control
 *    rendered and ignored the pointer.
 * 2. The appearance sliders stopped reaching the DOM at all: 3,797 nodes in
 *    the running app and not one matching "blur". A control that is absent
 *    cannot be dragged either, and looks identical to one that is broken.
 * 3. A verbosity slider handed `NaN` to `levels[NaN]`, which is `undefined`,
 *    which read as deliberately choosing the default and silently reset the
 *    setting.
 *
 * So the assertions are deliberately crude and cover the whole surface rather
 * than one control: **it is in the document**, **it has an accessible name**,
 * **its value is a number**, and **keyboard input changes that number**. A
 * slider that fails any of those is broken however pretty it looks.
 *
 * Keyboard rather than pointer on purpose. jsdom has no layout, so
 * `getBoundingClientRect` is all zeroes and a pointer drag cannot compute a
 * position here; the arrow keys go through the same `onChange` and
 * `onChangeEnd` the pointer path uses, so they prove the wiring without
 * needing a renderer. The pointer-specific half is what
 * `ps-blitz`'s `offset_metrics` test covers, in the engine, where the boxes
 * are real.
 */

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
  return { ...screen, workspace };
}

/** Every slider on the screen, however it was built. */
function sliders(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="slider"]'));
}

function sliderValue(slider: HTMLElement): number {
  return Number(slider.getAttribute("aria-valuenow"));
}

/**
 * What a screen reader would call this slider.
 *
 * Every one of these is named by `aria-labelledby` pointing at its `sr-only`
 * label, and none carries an `aria-label`. Reading only the latter reports
 * `(unnamed)` for the whole screen, which is how a failure here first got
 * pinned on the wrong control.
 */
function sliderName(container: HTMLElement, slider: HTMLElement): string {
  const label = slider.getAttribute("aria-label")?.trim();
  if (label) return label;
  const id = slider.getAttribute("aria-labelledby")?.trim();
  const target = id ? container.querySelector(`#${CSS.escape(id)}`) : null;
  return target?.textContent?.trim() || "(unnamed)";
}

beforeEach(() => setMockProxyActiveRuns(0));

describe("every slider in Settings", () => {
  /*
   * The absence case, which is the one that shipped. A control that never
   * reaches the document cannot be dragged, and every richer assertion below
   * would vacuously pass over an empty list.
   */
  it("renders the appearance sliders at all", async () => {
    const screen = await mountSettings();
    const found = sliders(screen.container);

    expect(found.length).toBeGreaterThan(0);

    /*
     * A name a screen reader can read. The visible label is `sr-only` on these
     * controls, so the association has to come through `aria-labelledby` or an
     * explicit `aria-label`; a slider with neither is an unlabelled spinner to
     * anyone not looking at the screen.
     */
    const unnamed = found.filter(
      (slider) =>
        !(slider.getAttribute("aria-label") ?? "").trim() &&
        !(slider.getAttribute("aria-labelledby") ?? "").trim(),
    );
    expect(unnamed.length, `${unnamed.length} slider(s) have no accessible name`).toBe(0);
  });

  /*
   * `NaN` is the failure mode this app actually hit, twice, and it is invisible
   * in the DOM: the attribute is present and the control looks fine.
   */
  it("gives every slider a real number for a value", async () => {
    const screen = await mountSettings();

    for (const slider of sliders(screen.container)) {
      const name = sliderName(screen.container, slider);
      const value = sliderValue(slider);
      expect(Number.isFinite(value), `${name} has a non-finite value: ${value}`).toBe(true);

      for (const bound of ["aria-valuemin", "aria-valuemax"]) {
        const raw = Number(slider.getAttribute(bound));
        expect(Number.isFinite(raw), `${name} has a non-finite ${bound}: ${raw}`).toBe(true);
      }
      expect(Number(slider.getAttribute("aria-valuemin")), `${name} has min >= max`).toBeLessThan(
        Number(slider.getAttribute("aria-valuemax")),
      );
    }
  });

  /*
   * The point of a slider. Arrow-key input goes through the same handlers the
   * pointer does, so a control that will not move here will not move under a
   * drag either.
   */
  it("moves every slider off its starting value", async () => {
    const screen = await mountSettings();

    for (const slider of sliders(screen.container)) {
      const name = sliderName(screen.container, slider);
      const before = sliderValue(slider);
      const min = Number(slider.getAttribute("aria-valuemin"));
      const max = Number(slider.getAttribute("aria-valuemax"));

      // Away from whichever end it is sitting on, so the move is never a no-op
      // against a bound.
      const key = before >= max ? "ArrowLeft" : "ArrowRight";
      slider.focus();
      fireEvent.keyDown(slider, { key });
      flush();

      await waitFor(
        () => {
          const after = sliderValue(slider);
          expect(
            after,
            `${name} did not move: ${before} -> ${after} (range ${min}..${max}, pressed ${key})`,
          ).not.toBe(before);
        },
        { timeout: 2_000 },
      );
    }
  });

  /*
   * And it stays moved.
   *
   * The fourth way these shipped broken: the drag itself worked, and the
   * release undid it. `onChangeEnd` handed the number to an async persist and
   * dropped its local override in the same breath, so until the write came
   * back the thumb fell to the *old* persisted value, snapped to where the
   * drag started, then jumped forward when the save landed.
   *
   * Every assertion above passes straight through that: they check the value
   * changes, never that it is still changed a moment later. So this one waits
   * out the round trip and looks again.
   */
  it("keeps every slider where it was released", async () => {
    const screen = await mountSettings();

    for (const slider of sliders(screen.container)) {
      const name = sliderName(screen.container, slider);
      const before = sliderValue(slider);
      const max = Number(slider.getAttribute("aria-valuemax"));
      const key = before >= max ? "ArrowLeft" : "ArrowRight";

      slider.focus();
      fireEvent.keyDown(slider, { key });
      flush();
      const released = sliderValue(slider);
      expect(released, `${name} did not move under ${key}`).not.toBe(before);

      // The release is the half under test: the library raises `onChangeEnd`
      // from `keyup`, and a `keydown` alone never runs the persist path.
      fireEvent.keyUp(slider, { key });

      /*
       * Sample across the whole write, not after it.
       *
       * The regression is a *transient*: the thumb falls back to the persisted
       * value only until the round trip lands, measured at about 60ms against
       * the mock. A single delayed read waits it out and sees the correct
       * final number, which is precisely how this shipped. So watch every
       * frame of the window and fail on any reading that is not where the
       * slider was released.
       */
      const deadline = Date.now() + 400;
      while (Date.now() < deadline) {
        const now = sliderValue(slider);
        expect(
          now,
          `${name} snapped back mid-write: released at ${released}, read ${now} (was ${before})`,
        ).toBe(released);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  });
});
