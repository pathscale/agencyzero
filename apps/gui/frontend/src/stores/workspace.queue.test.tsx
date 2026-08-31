import { flush } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS } from "~/api/fixtures";
import { setPrefs } from "~/stores/prefs";
import type { Workspace } from "~/stores/workspace";
import { bootWorkspace, waitFor } from "~/test/reactive";

const queueHarness = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  send: vi.fn(),
}));

vi.mock("~/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api")>();
  const { createMockApi } = await import("~/api/mock");

  return {
    ...actual,
    selectApi: async () => {
      const api = createMockApi();
      const originalOn = api.on.bind(api);
      const originalSend = api.sendMessage.bind(api);
      api.on = async (event, handler) => {
        queueHarness.handlers.set(event, handler as (payload: unknown) => void);
        return originalOn(event, handler);
      };
      queueHarness.send.mockImplementationOnce(async () => {
        throw new Error("a run is already active in this project — stop it or let it finish");
      });
      queueHarness.send.mockImplementation(originalSend);
      api.sendMessage = queueHarness.send;
      return {
        api,
        backend: "tauri" as const,
        live: new Set<keyof typeof api>(["sendMessage"]),
      };
    },
  };
});

async function mountWorkspace(): Promise<Workspace> {
  return bootWorkspace();
}

beforeEach(() => {
  queueHarness.handlers.clear();
  queueHarness.send.mockReset();
  SETTINGS.workspaceTabs = null;
  setPrefs((d) => {
    d.lastTabKey = "quux";
  });
  setPrefs((d) => {
    d.openTabKeys = ["quux"];
  });
});

describe("queued live follow-ups", () => {
  it("injects a startup-race message when the provider channel becomes ready", async () => {
    const workspace = await mountWorkspace();
    queueHarness.handlers.get("run:accepted")?.({
      projectId: "quux",
      agent: "codex",
      model: "gpt-5.6-sol",
      permission: "auto",
    });

    await workspace.actions.send("quux", "connect?");
    flush();
    expect(workspace.state.queued.quux).toHaveLength(1);
    expect(queueHarness.send).toHaveBeenCalledTimes(1);

    queueHarness.handlers.get("run:ready")?.({ projectId: "quux" });
    await waitFor(() => expect(queueHarness.send).toHaveBeenCalledTimes(2));
    expect(workspace.state.queued.quux).toHaveLength(0);
  });

  it("drains every ordered Codex steer instead of leaving later messages queued", async () => {
    const workspace = await mountWorkspace();
    queueHarness.handlers.get("run:accepted")?.({
      projectId: "quux",
      agent: "codex",
      model: "gpt-5.6-sol",
      permission: "auto",
    });

    await workspace.actions.send("quux", "first correction");
    await workspace.actions.send("quux", "second correction");

    await waitFor(() => expect(queueHarness.send).toHaveBeenCalledTimes(3));
    expect(workspace.state.queued.quux).toHaveLength(0);
    expect(queueHarness.send.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ body: "first correction" }),
    );
    expect(queueHarness.send.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ body: "second correction" }),
    );
  });

  it("retries the persisted user row instead of appending the prompt again", async () => {
    const workspace = await mountWorkspace();

    await workspace.actions.retry("quux", "msg-interrupted", "continue the audit");
    flush();

    expect(queueHarness.send).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "quux",
        body: "continue the audit",
        retryMessageId: "msg-interrupted",
      }),
    );
  });

  it("automatically retries the opening row after a rejected provider session", async () => {
    const workspace = await mountWorkspace();

    queueHarness.handlers.get("run:inject_failed")?.({
      projectId: "quux",
      messageId: "msg-session-rejected",
      body: "continue on the same session",
    });
    // The handler queues the retry through a store write; land it before
    // reading the queue back.
    flush();
    expect(workspace.state.queued.quux).toEqual([
      expect.objectContaining({
        messageId: "msg-session-rejected",
        body: "continue on the same session",
      }),
    ]);

    queueHarness.handlers.get("run:stopped")?.({
      projectId: "quux",
      agent: "claude",
      model: "claude-opus-5",
      permission: "auto",
      stop: "reconnected",
      exitCode: null,
    });
    flush();
    expect(queueHarness.send).not.toHaveBeenCalled();

    queueHarness.handlers.get("run:slot_released")?.({ projectId: "quux" });

    await waitFor(() => expect(queueHarness.send).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(queueHarness.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectId: "quux",
        body: "continue on the same session",
        retryMessageId: "msg-session-rejected",
      }),
    );
  });
});
