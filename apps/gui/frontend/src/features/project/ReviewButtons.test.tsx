import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { IconSprite } from "~/components/IconSprite";
import { ReviewButtons } from "~/features/project/ProjectTab";
import { reviewRunKey, useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";
import type { PullRequest } from "~/types";

const PR: PullRequest = {
  id: "pr-review",
  projectId: "project-review",
  url: "https://github.com/pathscale/agencyzero/pull/121",
  repo: "pathscale/agencyzero",
  number: 121,
  branch: "fix/example",
  state: "OPEN",
  additions: 3,
  deletions: 1,
  ci: "pass",
  dismissed: false,
};

async function mount() {
  let workspace!: Workspace;
  function Probe() {
    workspace = useWorkspace();
    return null;
  }
  const screen = render(() => (
    <WorkspaceProvider>
      <Probe />
      <IconSprite />
      <ReviewButtons pr={PR} />
    </WorkspaceProvider>
  ));
  await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });
  return { workspace, ...screen };
}

describe("pull request review buttons", () => {
  it("uses each review provider's local SVG mark", async () => {
    const { getByLabelText } = await mount();

    /*
     * The mark's own geometry, not a `<use>` naming it in a shared sprite.
     *
     * `blitz-dom` parses every inline `<svg>` into its own `usvg::Tree` from
     * that element's `outer_html`, so a reference to a `<symbol>` living in a
     * different tree resolved to nothing: the button had a correct box and a
     * correct stroke and no artwork in it. Asserting on the `href` passed
     * throughout that outage, which is why it asserts on the drawing now.
     */
    for (const label of ["Review with Claude", "Review with Codex", "Review with Copilot"]) {
      const path = getByLabelText(label).querySelector("svg path");
      expect(path, `${label} has no mark`).toBeInTheDocument();
      expect(path).toHaveAttribute("fill", "currentColor");
      expect(path).toHaveAttribute("stroke", "none");
    }
  });

  it("only disables a provider whose own review is pending", async () => {
    const { workspace, getByLabelText } = await mount();
    const review = vi.spyOn(workspace.actions, "reviewPullRequest");

    const claude = getByLabelText("Review with Claude") as HTMLButtonElement;
    const codex = getByLabelText("Review with Codex") as HTMLButtonElement;
    const copilot = getByLabelText("Review with Copilot") as HTMLButtonElement;

    fireEvent.click(claude);
    flush();
    expect(claude.disabled).toBe(true);
    expect(claude).toHaveAttribute("aria-busy", "true");
    expect(claude).toHaveAttribute("data-review-state", "running");
    expect(claude).toHaveClass("text-success");
    expect(workspace.state.reviewing[reviewRunKey(PR.url, "claude")]).toBe(true);
    expect(codex.disabled).toBe(false);
    expect(codex).toHaveAttribute("data-review-state", "idle");
    expect(copilot.disabled).toBe(false);

    fireEvent.click(codex);
    flush();
    expect(review).toHaveBeenCalledTimes(2);
    expect(claude.disabled).toBe(true);
    expect(codex.disabled).toBe(true);
    expect(copilot.disabled).toBe(false);

    await waitFor(() => expect(claude.disabled).toBe(false));
    // Absent rather than "false": the library omits `aria-busy` when the
    // button is not loading, which is the same thing to a screen reader.
    // `data-review-state` is ours and stays explicit either way.
    expect(claude).not.toHaveAttribute("aria-busy");
    expect(claude).toHaveAttribute("data-review-state", "idle");
    await waitFor(() => expect(codex.disabled).toBe(false));
  });
});
