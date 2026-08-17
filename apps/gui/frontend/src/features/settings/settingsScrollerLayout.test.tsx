/**
 * The settings page scrolls its content, not a crushed copy of it.
 *
 * The scroller is a *row* flex container that also carries `overflow-y: auto`
 * (via `az-scroll`). Its single child is therefore a flex item whose cross
 * axis is the height, so CSS's default `align-items: stretch` sized that
 * child to the scroller's own box instead of to its content.
 *
 * Measured on a blank pane: the 720px column reported 830px tall while
 * holding 7,764px of sections. Everything past 830px was clipped away, and a
 * scroll then parked that 830px stub thousands of pixels off screen. The pane
 * painted empty at 80fps with 13/13 layers used, every renderer metric
 * healthy and the whole document laid out, which is why it read for so long
 * as a paint or scroll-arithmetic bug rather than a layout one.
 *
 * `items-start` is what stops the stretch. jsdom has no layout, so this
 * asserts the composition rather than the resulting box: the class has to be
 * on the scrolling element itself, since that is the flex container whose
 * `align-items` decides the child's height.
 *
 * The structural fix is `ScrollArea` + `Flex align="start"` from
 * `@pathscale/ui`, where scrolling and layout are separate components and the
 * alignment is a named parameter rather than a silent CSS default. That
 * arrives with the UI 2.6.x migration; until then this guards the class.
 */

import { render, waitFor } from "@solidjs/testing-library";
import { beforeEach, expect, it } from "vitest";
import { setMockProxyActiveRuns } from "~/api/mock";
import { SettingsTab } from "~/features/settings/SettingsTab";
import { useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";

beforeEach(() => setMockProxyActiveRuns(0));

it("does not stretch the settings column to the scroller's height", async () => {
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

  // The page scroller: the `az-scroll` element that is also a flex container.
  const scrollers = Array.from(screen.container.querySelectorAll<HTMLElement>(".az-scroll")).filter(
    (el) => el.classList.contains("flex"),
  );
  expect(scrollers.length, "no scrolling flex container found; markup changed").toBeGreaterThan(0);

  for (const scroller of scrollers) {
    const classes = scroller.className;
    // `flex-col` stacks on the block axis, so the cross axis is horizontal and
    // a stretch cannot crush the height. Only row containers are at risk.
    if (classes.includes("flex-col")) continue;

    expect(
      classes,
      "a scrolling row-flex container without `items-start`: its child is a " +
        "flex item, so `align-items: stretch` sizes that child to the " +
        `scroller instead of its content and the overflow is clipped. Classes: ${classes}`,
    ).toMatch(/\bitems-(start|baseline)\b/);
  }
});
