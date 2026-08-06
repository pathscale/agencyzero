import { render, waitFor } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { MessageCost } from "~/features/project/TranscriptPane";
import { useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";
import type { Message } from "~/types";

function message(agent: Message["agent"], overrides: Partial<Message> = {}): Message {
  return {
    id: `${agent}-reply`,
    projectId: "proj-1",
    itemId: null,
    author: "agent",
    agent,
    moderation: null,
    model: agent === "claude" ? "opus" : "gpt-5.6-terra",
    permission: "edit",
    usage: {
      tokens: 340_500,
      inputTokens: 50_000,
      outputTokens: 40_500,
      contextTokens: 300_000,
      contextWindow: null,
      cacheReads: 250_000,
      cacheWrites: 0,
      reasoningTokens: null,
      costUsd: agent === "claude" ? 2.89 : null,
      premiumRequests: null,
      durationMs: 600_000,
    },
    stop: "completed",
    exitCode: 0,
    body: "Done.",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function mount(value: Message) {
  let workspace!: Workspace;
  function Probe() {
    workspace = useWorkspace();
    return null;
  }
  const screen = render(() => (
    <WorkspaceProvider>
      <Probe />
      <MessageCost message={value} />
    </WorkspaceProvider>
  ));
  const booted = () => waitFor(() => expect(workspace.state.boot.status).toBe("ready"));
  return { ...screen, booted };
}

describe("per-message cost and tokens", () => {
  it("puts Claude's processed tokens beside its reported cost", async () => {
    const { container, booted } = mount(message("claude"));
    await waitFor(() => expect(container).toHaveTextContent("$2.89 · calc $1.39 · 340.5k tok"));
    await booted();
  });

  it("keeps a matching Claude token-derived check quiet", async () => {
    const matching = message("claude");
    matching.usage!.costUsd = 1.3875;
    const { container, getByTitle, booted } = mount(matching);
    await waitFor(() => expect(container).toHaveTextContent("$1.39 · 340.5k tok"));
    expect(container).not.toHaveTextContent("calc $1.39");
    await booted();
    expect(
      getByTitle("Reported by the agent: $1.39. Token-derived check: $1.39."),
    ).toBeInTheDocument();
  });

  it("puts Codex's processed tokens beside its estimated cost", async () => {
    const { container, booted } = mount(message("codex"));
    await waitFor(() => expect(container).toHaveTextContent("est. $0.636 · 340.5k tok"));
    await booted();
  });

  it("does not invent a cost for a legacy multi-call Codex turn", async () => {
    const legacy = message("codex");
    delete legacy.usage?.inputTokens;
    delete legacy.usage?.outputTokens;
    delete legacy.usage?.cacheWrites;
    const { container, booted } = mount(legacy);
    await waitFor(() => expect(container).toHaveTextContent("340.5k tok"));
    expect(container).not.toHaveTextContent("est.");
    await booted();
  });
});
