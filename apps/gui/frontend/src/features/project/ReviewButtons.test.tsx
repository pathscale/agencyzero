import { fireEvent, render, waitFor } from "@solidjs/testing-library";
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
    const { getByLabelText, container } = await mount();
    const href = (label: string) =>
      getByLabelText(label).querySelector("use")?.getAttribute("href");

    expect(href("Review with Claude")).toBe("#i-vendor-claude");
    expect(href("Review with Codex")).toBe("#i-vendor-openai");
    expect(href("Review with Copilot")).toBe("#i-vendor-copilot");
    for (const id of ["i-vendor-claude", "i-vendor-openai", "i-vendor-copilot"]) {
      const path = container.querySelector(`#${id} path`);
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
    expect(claude.disabled).toBe(true);
    expect(claude).toHaveAttribute("aria-busy", "true");
    expect(claude).toHaveAttribute("data-state", "running");
    expect(claude).toHaveClass("text-success");
    expect(workspace.state.reviewing[reviewRunKey(PR.url, "claude")]).toBe(true);
    expect(codex.disabled).toBe(false);
    expect(codex).toHaveAttribute("data-state", "idle");
    expect(copilot.disabled).toBe(false);

    fireEvent.click(codex);
    expect(review).toHaveBeenCalledTimes(2);
    expect(claude.disabled).toBe(true);
    expect(codex.disabled).toBe(true);
    expect(copilot.disabled).toBe(false);

    await waitFor(() => expect(claude.disabled).toBe(false));
    expect(claude).toHaveAttribute("aria-busy", "false");
    expect(claude).toHaveAttribute("data-state", "idle");
    await waitFor(() => expect(codex.disabled).toBe(false));
  });
});
