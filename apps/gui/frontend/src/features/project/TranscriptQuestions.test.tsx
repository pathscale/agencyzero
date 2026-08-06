import { render, waitFor } from "@solidjs/testing-library";
import { Show } from "solid-js";
import { describe, expect, it } from "vitest";
import { TranscriptPane } from "~/features/project/TranscriptPane";
import { useWorkspace, WorkspaceProvider } from "~/stores/workspace";

function TranscriptHarness() {
  const workspace = useWorkspace();
  const project = () => workspace.state.projects.find((candidate) => candidate.id === "cafe");

  return (
    <Show when={workspace.state.boot.status === "ready" && project()}>
      {(readyProject) => (
        <TranscriptPane
          project={readyProject()}
          messages={workspace.state.messages.cafe ?? []}
          streaming=""
        />
      )}
    </Show>
  );
}

describe("transcript questions", () => {
  it("keeps an open question at the bottom and labels it as a question", async () => {
    const screen = render(() => (
      <WorkspaceProvider>
        <TranscriptHarness />
      </WorkspaceProvider>
    ));

    const question = await screen.findByText("Fork codex, or keep patching the integration?");
    const latestReply = screen.getByText(
      "Paused. The scan itself is unaffected; only the cleanup step is blocked.",
    );

    expect(screen.getByText("Question")).toBeInTheDocument();
    expect(
      latestReply.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    await waitFor(() => expect(question.closest("[data-selectable]")).not.toBeNull());
  });
});
