import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { Show } from "solid-js";
import { describe, expect, it } from "vitest";
import { nextOpenQuestion, TranscriptPane } from "~/features/project/TranscriptPane";
import { prefs, setPrefs } from "~/stores/prefs";
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
  it("shows only the oldest unanswered question in a stacked backlog", () => {
    const next = nextOpenQuestion([
      {
        id: "q-later",
        projectId: "cafe",
        text: "Later",
        urgency: "blocking",
        answered: false,
        createdAt: "2026-08-05T02:00:00Z",
      },
      {
        id: "q-answered",
        projectId: "cafe",
        text: "Done",
        urgency: "blocking",
        answered: true,
        createdAt: "2026-08-05T00:00:00Z",
      },
      {
        id: "q-first",
        projectId: "cafe",
        text: "First",
        urgency: "passive",
        answered: false,
        createdAt: "2026-08-05T01:00:00Z",
      },
    ]);

    expect(next?.id).toBe("q-first");
  });

  it("keeps an open question at the bottom and labels it as a question", async () => {
    setPrefs("openTabKeys", ["cafe"]);
    const screen = render(() => (
      <WorkspaceProvider>
        <TranscriptHarness />
      </WorkspaceProvider>
    ));

    const question = await screen.findByText("Fork codex, or keep patching the integration?");
    const latestReply = screen.getByText(
      "Paused. The scan itself is unaffected; only the cleanup step is blocked.",
    );
    const card = question.parentElement?.parentElement;

    expect(screen.getByText("Question #1")).toBeInTheDocument();
    expect(card).toHaveClass("border-error");
    expect(card).not.toHaveClass("opacity-45");
    expect(
      latestReply.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    await waitFor(() => expect(question.closest("[data-selectable]")).not.toBeNull());
  });

  it("stages the exact question when Reply is clicked", async () => {
    setPrefs("replyQuestionIds", {});
    setPrefs("openTabKeys", ["cafe"]);
    const screen = render(() => (
      <WorkspaceProvider>
        <TranscriptHarness />
      </WorkspaceProvider>
    ));

    const reply = await screen.findByRole("button", { name: "Reply to this question" });
    fireEvent.click(reply);

    await waitFor(() => expect(prefs.replyQuestionIds.cafe).toBe("q-block"));
  });
});
