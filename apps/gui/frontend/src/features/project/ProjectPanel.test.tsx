import { fireEvent, render, waitFor, within } from "@solidjs/testing-library";
import { flush, Show } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { itemPage, PROJECT_ITEM_PAGE_SIZE, ProjectPanel } from "~/features/project/ProjectPanel";
import { prefs } from "~/stores/prefs";
import { useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";
import type { Project } from "~/types";

const PROJECT: Project = {
  id: "panel-scroll",
  name: "Panel scroll",
  status: "active",
  order: 0,
  dirs: [],
  pinned: false,
  moderatorEnabled: false,
  forkedFrom: null,
  sessionId: null,
  sessions: {},
  lastActivityAt: "2026-08-07T00:00:00.000Z",
};

describe("the project side panel", () => {
  it("bounds the initially mounted item list", () => {
    const items = Array.from({ length: PROJECT_ITEM_PAGE_SIZE + 5 }, (_, index) => index);

    expect(itemPage(items, PROJECT_ITEM_PAGE_SIZE)).toEqual(items.slice(0, PROJECT_ITEM_PAGE_SIZE));
    expect(itemPage(items, PROJECT_ITEM_PAGE_SIZE * 2)).toEqual(items);
  });

  it("pages a large live item list without hiding the remaining rows", async () => {
    let workspace!: Workspace;

    function Gate() {
      workspace = useWorkspace();
      return (
        <Show when={workspace.state.boot.status === "ready"}>
          <ProjectPanel project={{ ...PROJECT, id: "worktable" }} agent="codex" />
        </Show>
      );
    }

    const screen = render(() => (
      <WorkspaceProvider>
        <Gate />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });

    for (let index = 0; index < PROJECT_ITEM_PAGE_SIZE + 5; index += 1) {
      await workspace.actions.createItem("worktable", `Paged item ${index}`);
    }

    await waitFor(() =>
      expect(screen.container.querySelectorAll("[data-item-id]")).toHaveLength(
        PROJECT_ITEM_PAGE_SIZE,
      ),
    );
    const more = screen.getByRole("button", { name: /Show \d+ more items/ });
    fireEvent.click(more);
    flush();
    await waitFor(() =>
      expect(screen.container.querySelectorAll("[data-item-id]").length).toBeGreaterThan(
        PROJECT_ITEM_PAGE_SIZE,
      ),
    );
  });

  it("fills its clipped shell so the panel owns a bounded scroll area", async () => {
    let workspace!: Workspace;

    function Gate() {
      workspace = useWorkspace();
      return (
        <Show when={workspace.state.boot.status === "ready"}>
          <div data-testid="shell" class="h-[320px] overflow-hidden">
            <ProjectPanel project={PROJECT} agent="codex" />
          </div>
        </Show>
      );
    }

    const screen = render(() => (
      <WorkspaceProvider>
        <Gate />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });

    const panel = screen.getByTestId("shell").firstElementChild as HTMLElement;
    expect(panel.classList).toContain("h-full");
    expect(panel.classList).toContain("az-scroll");
    expect(panel.classList).toContain("min-h-0");
    expect(panel.classList).toContain("overflow-y-auto");

    const items = screen.getByRole("button", { name: "Collapse Items" }).closest(".rounded-panel");
    expect(items?.classList).toContain("flex-none");
    expect(items?.className).toContain("min-h-[52px]");
  });

  it("keeps the Agent I/O checkbox fully inside the expanded panel body", async () => {
    let workspace!: Workspace;

    function Gate() {
      workspace = useWorkspace();
      return (
        <Show when={workspace.state.boot.status === "ready"}>
          <ProjectPanel project={{ ...PROJECT, id: "worktable" }} agent="codex" />
        </Show>
      );
    }

    const screen = render(() => (
      <WorkspaceProvider>
        <Gate />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });
    const expand = screen.queryByRole("button", { name: "Expand Agent I/O" });
    if (expand) fireEvent.click(expand);

    /*
     * The control is `.checkbox__control`, not `[data-slot=checkbox-control]`.
     *
     * `@pathscale/ui` emits `data-slot` for a few semantic parts — `checkbox`
     * here — and BEM classes for its internals, so the slot this used to query
     * does not exist. It passed anyway, because it went on to assert that the
     * *class string* contained `[&_[data-slot=checkbox-control]]:size-4`: a
     * utility sitting in a string, naming a selector that matches nothing.
     *
     * The sizing now lives in `theme.css` behind `.az-compact-checkbox`, which
     * is guarded there and by `deadSelectors.test.ts`. What matters here is
     * that the hook is on the element and the control is where it belongs.
     */
    const input = screen.getByRole("checkbox", { name: "Keep across restarts" });
    const label = input.closest<HTMLElement>('[data-slot="checkbox"]');
    const control = label?.querySelector<HTMLElement>(".checkbox__control");
    if (!label || !control) throw new Error("Agent I/O checkbox control was not rendered");
    expect(label).toHaveClass("py-2");
    expect(label).toHaveClass("az-compact-checkbox");
    expect(input.nextElementSibling).toBe(control);
  });

  it("adopts a recovered session into the active Claude provider", async () => {
    let workspace!: Workspace;
    const recovered = "f462e5c2-d5dd-42bd-a462-63256e2adf99";

    function Gate() {
      workspace = useWorkspace();
      return (
        <Show when={workspace.state.boot.status === "ready"}>
          <ProjectPanel
            project={{ ...PROJECT, sessions: { claude: "existing-claude-session" } }}
            agent="claude"
          />
        </Show>
      );
    }

    const screen = render(() => (
      <WorkspaceProvider>
        <Gate />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });
    const adopt = vi.spyOn(workspace.actions, "adoptSession").mockResolvedValue();
    /*
     * By label rather than by role, to route around a jsdom crash.
     *
     * A name-filtered `*ByRole` query runs testing-library's accessibility
     * check, which calls `getComputedStyle`, and jsdom 30 throws resolving a
     * font size there: "object null is not iterable" from
     * `resolveLengthInPixels`. That is a jsdom bug rather than anything about
     * this panel, and a label query finds the same button without walking the
     * computed styles.
     */
    const expandSettings = screen.queryByLabelText("Expand Settings");
    if (expandSettings) fireEvent.click(expandSettings);

    expect(screen.getByText("Attached: existing-claude-session")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Change"));
    flush();
    fireEvent.input(screen.getByPlaceholderText("session id, e.g. 019fc95e-…"), {
      target: { value: recovered },
    });
    // Land the typed session id before Attach reads it back.
    flush();
    fireEvent.click(screen.getByText("Attach"));
    flush();

    await waitFor(() => expect(adopt).toHaveBeenCalledWith(PROJECT.id, "claude", recovered));
  });

  it("keeps the lower-token fork action visible without waiting for hover", async () => {
    let workspace!: Workspace;

    function Gate() {
      workspace = useWorkspace();
      return (
        <Show when={workspace.state.boot.status === "ready"}>
          <ProjectPanel project={{ ...PROJECT, id: "worktable" }} agent="codex" />
        </Show>
      );
    }

    const screen = render(() => (
      <WorkspaceProvider>
        <Gate />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });

    const fork = screen.getAllByLabelText(/Fork .* into a fresh chat/)[0];
    expect(fork.classList).not.toContain("opacity-0");
    expect(fork.getAttribute("title")).toContain("avoid resending");
  });

  it("shows editable item context before creating a fresh fork", async () => {
    let workspace!: Workspace;

    function Gate() {
      workspace = useWorkspace();
      return (
        <Show when={workspace.state.boot.status === "ready"}>
          <ProjectPanel project={{ ...PROJECT, id: "worktable" }} agent="codex" />
        </Show>
      );
    }

    const screen = render(() => (
      <WorkspaceProvider>
        <Gate />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });

    fireEvent.click(screen.getAllByLabelText(/Fork .* into a fresh chat/)[0]);
    flush();
    await waitFor(() => expect(document.body.querySelector('[role="dialog"]')).not.toBeNull());
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.className).not.toContain("backdrop-blur");
    expect(within(dialog).getByRole("heading", { name: "Prepare item fork" })).toBeVisible();
    const context = within(dialog).getByLabelText("Description / sub-items");
    expect((context as HTMLTextAreaElement).value).toContain("Details / sub-items");
    fireEvent.input(context, {
      target: { value: "Preserve the owner decision and run the focused tests." },
    });
    // Land the edit before the button reads it: Solid 2 queues the write, so
    // Start fork would otherwise submit the untouched description.
    flush();
    fireEvent.click(within(dialog).getByRole("button", { name: "Start fork" }));
    flush();

    await waitFor(() =>
      expect(workspace.state.projects.some((project) => project.forkedFrom?.itemId)).toBe(true),
    );
    const fork = workspace.state.projects.find((project) => project.forkedFrom?.itemId);
    expect(fork).toBeDefined();
    expect(await workspace.actions.getItemContext(fork?.forkedFrom?.itemId ?? "missing")).toContain(
      "owner decision",
    );
  });

  it("edits a persistent description from the item row without starting a fork", async () => {
    let workspace!: Workspace;

    function Gate() {
      workspace = useWorkspace();
      return (
        <Show when={workspace.state.boot.status === "ready"}>
          <ProjectPanel project={{ ...PROJECT, id: "worktable" }} agent="codex" />
        </Show>
      );
    }

    const screen = render(() => (
      <WorkspaceProvider>
        <Gate />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });

    const clickDescription = () =>
      fireEvent.click(
        screen.getAllByRole("button", {
          name: /^Edit the description for /,
        })[0],
      );
    clickDescription();
    const description = await screen.findByLabelText("Description / sub-items");
    expect((description as HTMLTextAreaElement).value).toBe("");
    fireEvent.input(description, {
      target: { value: "- [ ] Profile prompt cache\n- [ ] Verify cost" },
    });
    // Land the typed value before Save reads it back.
    flush();
    fireEvent.click(screen.getByRole("button", { name: "Save description" }));
    flush();

    await waitFor(async () =>
      expect(await workspace.actions.getItemContext("worktable-1")).toContain(
        "Profile prompt cache",
      ),
    );
    clickDescription();
    flush();
    expect(screen.queryByLabelText("Description / sub-items")).toBeNull();
    clickDescription();
    flush();
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Description / sub-items") as HTMLTextAreaElement).value,
      ).toContain("Profile prompt cache"),
    );
    expect(workspace.state.projects.some((project) => project.forkedFrom?.itemId)).toBe(false);
  });

  it("keeps a dismissed item question reachable from a clear third action", async () => {
    let workspace!: Workspace;

    function Gate() {
      workspace = useWorkspace();
      const project = () => workspace.state.projects.find((candidate) => candidate.id === "cafe");
      return (
        <Show when={workspace.state.boot.status === "ready" && project()}>
          {(readyProject) => <ProjectPanel project={readyProject()} agent="codex" />}
        </Show>
      );
    }

    const screen = render(() => (
      <WorkspaceProvider>
        <Gate />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });
    workspace.actions.openProject("cafe");
    flush();
    await waitFor(() => expect(workspace.state.questions.cafe?.[0]?.id).toBe("q-block"), {
      timeout: 5_000,
    });
    await workspace.actions.setItemStatus("cafe-0", "questions");
    await workspace.actions.answerQuestion("q-block", true);
    flush();

    const initialReplies = await screen.findAllByRole("button", {
      name: "Reply to the question for Legacy-data scan on prod snapshot",
    });
    expect(initialReplies).toHaveLength(1);
    const row = screen.container.querySelector('[data-item-id="cafe-0"]');
    if (!row) throw new Error("question item row is missing");
    fireEvent.pointerEnter(row);
    flush();
    const replies = await screen.findAllByRole("button", {
      name: "Reply to the question for Legacy-data scan on prod snapshot",
    });
    expect(replies).toHaveLength(2);
    const reply = replies.find((button) => button.className.includes("size-[22px]"));
    expect(reply).toBeDefined();
    if (!reply) throw new Error("persistent reply action is missing");
    expect(reply.className).toContain("size-[22px]");
    expect(reply.className).toContain("border-warning/65");
    expect(row?.querySelector('use[href="#i-circle-help"]')).not.toBeNull();
    fireEvent.click(reply);
    flush();

    await waitFor(() => expect(prefs.replyQuestionIds.cafe).toBe("q-block"));
  });

  it("offers to work a questions item when no tracked question exists", async () => {
    let workspace!: Workspace;

    function Gate() {
      workspace = useWorkspace();
      const project = () => workspace.state.projects.find((candidate) => candidate.id === "quux");
      return (
        <Show when={workspace.state.boot.status === "ready" && project()}>
          {(readyProject) => <ProjectPanel project={readyProject()} agent="codex" />}
        </Show>
      );
    }

    const screen = render(() => (
      <WorkspaceProvider>
        <Gate />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.items.quux?.length).toBeGreaterThan(0), {
      timeout: 5_000,
    });
    const send = vi.spyOn(workspace.actions, "send");
    await workspace.actions.setItemStatus("quux-0", "questions");
    flush();

    const work = await screen.findByRole("button", {
      name: "Work on Wire the component library; it has no unanswered question",
    });
    expect(work.className).toContain("size-[22px]");
    fireEvent.click(work);
    flush();

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls.at(-1)?.[4]).toBe("quux-0");
  });

  it("stacks an item status with its issue or pull-request reference", async () => {
    let workspace!: Workspace;

    function Gate() {
      workspace = useWorkspace();
      return (
        <Show when={workspace.state.boot.status === "ready"}>
          <ProjectPanel project={{ ...PROJECT, id: "worktable" }} agent="codex" />
        </Show>
      );
    }

    const screen = render(() => (
      <WorkspaceProvider>
        <Gate />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });
    await workspace.actions.setItemStatus("worktable-0", "shipped");
    await workspace.actions.setItemIssue(
      "worktable-0",
      "https://github.com/pathscale/WorkTable/issues/58",
    );

    const row = screen.container.querySelector('[data-item-id="worktable-0"]');
    if (!row) throw new Error("item row is missing");
    expect(within(row as HTMLElement).getByText("(Shipped)")).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("(issue #58)")).toBeInTheDocument();
  });

  /*
   * The rows are rendered from the sorted, paged view; the order written back
   * is the project's own. Those two agree only under a status sort on a list
   * whose statuses already sit in ladder order, so an index taken from the
   * screen and applied to the stored list swapped the wrong pair. The default
   * sort is `status`/`asc`, which is exactly where this bit.
   */
  it("moves the row under the cursor, not the one at that index in the stored order", async () => {
    let workspace!: Workspace;

    function Gate() {
      workspace = useWorkspace();
      return (
        <Show when={workspace.state.boot.status === "ready"}>
          <ProjectPanel project={{ ...PROJECT, id: "worktable" }} agent="codex" />
        </Show>
      );
    }

    const screen = render(() => (
      <WorkspaceProvider>
        <Gate />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });

    /*
     * The fixture's stored order is 0..4, but its statuses are not in ladder
     * order: item 4 is `finished` and sinks, so the screen and the store
     * disagree from the first frame under the default sort.
     */
    const rendered = () =>
      [...screen.container.querySelectorAll("[data-item-id]")].map((row) =>
        row.getAttribute("data-item-id"),
      );
    await waitFor(() => expect(rendered().length).toBeGreaterThan(2));
    const onScreen = rendered();
    const stored = (workspace.state.items.worktable ?? []).map((item) => item.id);
    expect(onScreen).not.toEqual(stored.slice(0, onScreen.length));

    // The second row on screen, moved up: it should trade places with the
    // first row on screen, whatever its position in the stored order.
    const mover = onScreen[1];
    const displaced = onScreen[0];
    if (!mover || !displaced) throw new Error("not enough rows to reorder");
    const title = (id: string) =>
      (workspace.state.items.worktable ?? []).find((item) => item.id === id)?.title ?? "";

    const reorderItems = vi.spyOn(workspace.actions, "reorderItems");
    // The row controls are revealed on hover, so the pointer has to be on the
    // row before its arrows exist to click.
    const row = screen.container.querySelector<HTMLElement>(`[data-item-id="${mover}"]`);
    if (!row) throw new Error("the row to move is missing");
    fireEvent.pointerEnter(row);
    flush();

    const up = screen.container.querySelector<HTMLElement>(
      `[aria-label="Move ${title(mover)} up"]`,
    );
    if (!up) throw new Error("the move-up control is missing");
    fireEvent.click(up);
    flush();

    await waitFor(() => expect(reorderItems).toHaveBeenCalled());
    const written = reorderItems.mock.calls.at(-1)?.[1];
    if (!written) throw new Error("no order was written");
    expect(written.indexOf(mover)).toBeLessThan(written.indexOf(displaced));
    // The move is a swap, so it must neither add nor drop a row.
    expect(new Set(written)).toEqual(new Set(stored));
  });
});
