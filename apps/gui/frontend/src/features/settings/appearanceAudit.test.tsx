/**
 * Every control in the appearance pane renders, is named, and carries a colour.
 *
 * The pane is a wall of coloured circles: a 31-petal surface wheel, six accent
 * swatches, and four rows of preview swatches for strength, softness, text
 * brightness and the rest. They shipped as *empty rings* - the outline drawn,
 * the fill absent - and every layer tested clean in isolation while the
 * assembled pane was wrong.
 *
 * That is the gap this file closes. The unit under test is the pane as the
 * user meets it, and the assertions are the ones a person makes by looking:
 *
 *   - the control exists (an absent swatch and a colourless one look the same),
 *   - it has a name, since these have no text,
 *   - it has a background colour that is a real colour and not `transparent`,
 *   - clicking one changes the stored setting.
 *
 * A swatch whose whole job is to show a colour, showing no colour, is the bug.
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

/** Controls whose accessible name starts with `prefix`. */
function named(container: HTMLElement, prefix: RegExp): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[aria-label]")).filter((element) =>
    prefix.test(element.getAttribute("aria-label") ?? ""),
  );
}

/**
 * The colour a swatch actually paints.
 *
 * Read off the inline style rather than through `getComputedStyle`: jsdom does
 * not apply a stylesheet's cascade the way a renderer does, and the inline
 * declaration is what these controls set, so it is both the honest source and
 * the one that broke.
 */
function fillOf(element: HTMLElement): string {
  return (element.style.backgroundColor || "").trim();
}

/**
 * Whether this control paints a colour anywhere the user would see it.
 *
 * The fill sits on a child rather than the control: the library's `Button`
 * drops `style` entirely, so the colour is carried by an element it does not
 * own. Looking only at the labelled node would test the wrong element and
 * report a working swatch as broken.
 */
function paintsAColour(element: HTMLElement): boolean {
  return [element, ...Array.from(element.querySelectorAll<HTMLElement>("*"))].some((node) =>
    isVisibleColour(fillOf(node)),
  );
}

/** A colour that will actually show up. */
function isVisibleColour(value: string): boolean {
  if (!value) return false;
  const empty = ["transparent", "initial", "inherit", "unset", "none", "currentcolor"];
  if (empty.includes(value.toLowerCase())) return false;
  // `rgba(...)` with a zero alpha paints nothing, which is the same defect
  // wearing a different spelling.
  const alpha = /rgba?\([^)]*?,\s*(0|0?\.0+)\s*\)$/i.exec(value);
  return !alpha;
}

beforeEach(() => setMockProxyActiveRuns(0));

describe("the appearance pane's swatches", () => {
  it("renders the surface wheel, and every petal carries a colour", async () => {
    const screen = await mountSettings();
    const petals = named(screen.container, /^Surface colour /);

    // 31 petals: three concentric rings plus the centre.
    expect(petals.length).toBe(31);

    for (const petal of petals) {
      const name = petal.getAttribute("aria-label") ?? "(unnamed)";
      /*
       * A petal is a `Radio`, and its colour is handed in as the `indicator`
       * prop, which the library renders as a *sibling* of the visually hidden
       * input that carries the label. So the search starts at the wrapper the
       * app positions, not at the labelled node.
       */
      const wrapper = petal.closest<HTMLElement>("[data-surface-petal]") ?? petal;
      expect(paintsAColour(wrapper), `${name} paints no colour`).toBe(true);
    }
  });

  it("renders the accent swatches, and every one carries a colour", async () => {
    const screen = await mountSettings();
    const swatches = named(screen.container, /^(Accent colour|The designed)/);

    expect(swatches.length).toBeGreaterThan(0);

    for (const swatch of swatches) {
      const name = swatch.getAttribute("aria-label") ?? "(unnamed)";
      expect(paintsAColour(swatch), `${name} paints no colour`).toBe(true);
    }
  });

  /*
   * The rows beside the wheel: strength, softness, text brightness. These are
   * the ones reported as "still fucked up" after the wheel itself was fine, so
   * they get their own case rather than being folded into the accent one.
   */
  it("renders every preview row, and every stop carries a colour", async () => {
    const screen = await mountSettings();

    for (const row of [/^Colour strength /, /^Softness /, /^Text brightness /]) {
      const stops = named(screen.container, row);
      expect(stops.length, `${row} matched no swatches`).toBeGreaterThan(0);

      for (const stop of stops) {
        const name = stop.getAttribute("aria-label") ?? "(unnamed)";
        expect(paintsAColour(stop), `${name} paints no colour`).toBe(true);
      }
    }
  });

  /* A swatch that cannot be chosen is decoration. */
  it("applies the colour strength a swatch is clicked with", async () => {
    const screen = await mountSettings();
    const stops = named(screen.container, /^Colour strength /);
    const before = screen.workspace.state.settings?.theme.wash;

    const target = stops.find((stop) => stop.getAttribute("aria-pressed") !== "true");
    expect(target, "every strength swatch already reads as selected").toBeTruthy();
    fireEvent.click(target as HTMLElement);

    await waitFor(() => expect(screen.workspace.state.settings?.theme.wash).not.toBe(before));
  });
});
