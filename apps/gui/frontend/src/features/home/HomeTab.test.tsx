import { fireEvent, render, waitFor, within } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
  CleanupRowActions,
  HOME_PROJECT_PAGE_SIZE,
  HomeTab,
  projectPage,
  TASK_CLEANUP_PROMPT,
} from "~/features/home/HomeTab";
import { setPrefs } from "~/stores/prefs";
import { useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";

async function mountHome() {
  let workspace!: Workspace;

  function Probe() {
    workspace = useWorkspace();
    return null;
  }

  const screen = render(() => (
    <WorkspaceProvider>
      <Probe />
      <HomeTab />
    </WorkspaceProvider>
  ));

  await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });
  return { ...screen, workspace };
}

describe("Home item rows", () => {
  it("bounds the initially mounted project list", () => {
    const projects = Array.from({ length: HOME_PROJECT_PAGE_SIZE + 5 }, (_, index) => index);

    expect(projectPage(projects, HOME_PROJECT_PAGE_SIZE)).toEqual(
      projects.slice(0, HOME_PROJECT_PAGE_SIZE),
    );
    expect(projectPage(projects, HOME_PROJECT_PAGE_SIZE * 2)).toEqual(projects);
  });

  it("reserves one status column so the trailing item actions align", async () => {
    const screen = await mountHome();
    const statusControls = screen.getAllByRole("button", { name: /^Change the status of / });

    for (const control of statusControls) {
      expect(control.parentElement?.lastElementChild).toHaveClass("w-[96px]", "text-right");
    }
  });

  it("always exposes Clean-up and stages proposals through Task Manager", async () => {
    const screen = await mountHome();
    const send = vi.spyOn(screen.workspace.actions, "sendTaskPrompt").mockResolvedValue(undefined);

    expect(screen.queryByRole("button", { name: "Confirm delete" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clean-up" }));
    flush();

    await waitFor(() => expect(send).toHaveBeenCalledWith(TASK_CLEANUP_PROMPT, undefined, true));
    expect(TASK_CLEANUP_PROMPT).toContain('{"deleteItemIds"');
    expect(TASK_CLEANUP_PROMPT).toContain("do not inspect files");
    expect(screen.queryByRole("button", { name: "Confirm delete" })).toBeNull();
  });

  it("reviews each cleanup proposal on its own item row", async () => {
    const onKeep = vi.fn(async () => undefined);
    const onConfirm = vi.fn(async () => undefined);
    const item = {
      id: "item-review-delete",
      projectId: "worktable",
      title: "Review before deleting",
      status: "planning" as const,
      order: 0,
      reference: null,
      deleteProposed: true,
    };
    const screen = render(() => (
      <CleanupRowActions item={item} onKeep={onKeep} onConfirm={onConfirm} />
    ));

    expect(screen.getByRole("checkbox", { name: "Delete Review before deleting" })).toBeChecked();
    expect(onConfirm).not.toHaveBeenCalled();

    /*
     * `change`, not `click`. The row listens for the box being *unchecked*,
     * and jsdom toggles `checked` on a click without dispatching the `change`
     * that a browser would, so the handler returned early on a box it still
     * saw as checked and `onKeep` never ran.
     */
    const box = screen.getByRole("checkbox", {
      name: "Delete Review before deleting",
    }) as HTMLInputElement;
    box.checked = false;
    fireEvent.change(box);
    flush();
    // Called synchronously by the change handler, so assert it here: a
    // `waitFor` retries past the point this row is torn down.
    expect(onKeep).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();

    /*
     * Wait for the keep run to settle before clicking Confirm.
     *
     * Both actions share one `busy` signal and Confirm is `disabled` while it
     * is set, so clicking while the keep promise is still in flight lands on a
     * disabled button and does nothing. Solid 1 happened to have cleared it by
     * now; Solid 2 defers the write that clears it.
     */
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    flush();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
  });

  it("sorts legacy Home items by time and direction instead of only changing the labels", async () => {
    const screen = await mountHome();
    const controls = screen.getByRole("group", { name: "Sort projects and items" });
    const [by, direction] = Array.from(controls.querySelectorAll("button"));
    const worktableOrder = () =>
      screen
        .getAllByRole("button", { name: /^Change the status of / })
        .map((button) => button.getAttribute("aria-label"))
        .filter((label) =>
          [
            "Change the status of Phase A — safety quick-wins → 0.9.3",
            "Change the status of Phase B — engine observability (API break)",
            "Change the status of Phase C — benches before the rewrite",
            "Change the status of Reader-model design proposal",
            "Change the status of Ship corrective 0.9.2 release",
          ].includes(label ?? ""),
        );

    fireEvent.click(by);
    flush();
    expect(by).toHaveTextContent("Time");
    expect(worktableOrder()[0]).toContain("Phase A");
    fireEvent.click(direction);
    flush();
    expect(worktableOrder()[0]).toContain("Ship corrective");
  });

  it("sorts the Home project groups instead of leaving the dominant rows fixed", async () => {
    setPrefs((d) => {
      d.homeSortBy = "status";
    });
    setPrefs((d) => {
      d.homeSortDirection = "asc";
    });
    const screen = await mountHome();
    const controls = screen.getByRole("group", { name: "Sort projects and items" });
    const [by, direction] = Array.from(controls.querySelectorAll("button"));
    const projectOrder = () =>
      Array.from(screen.container.querySelectorAll<HTMLElement>("[data-project-id]")).map(
        (project) => project.dataset.projectId,
      );

    expect(projectOrder()).toEqual(["cafe", "quux", "worktable"]);
    fireEvent.click(direction);
    flush();
    expect(projectOrder()).toEqual(["worktable", "quux", "cafe"]);

    fireEvent.click(by);
    flush();
    expect(by).toHaveTextContent("Time");
    expect(projectOrder()).toEqual(["worktable", "cafe", "quux"]);

    fireEvent.click(by);
    flush();
    expect(by).toHaveTextContent("Turns");
    expect(projectOrder()).toEqual(["cafe", "worktable", "quux"]);
  });

  it("expands one item description and closes it when another item receives focus", async () => {
    const screen = await mountHome();

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit the description for / })[0]);
    expect(await screen.findByLabelText("Description / sub-items")).toBeTruthy();

    fireEvent.focusIn(screen.getAllByRole("button", { name: /^Change the status of / })[1]);
    await waitFor(() => expect(screen.queryByLabelText("Description / sub-items")).toBeNull());
  });

  it("prefills the description dialog before starting a Home item fork", async () => {
    const screen = await mountHome();

    fireEvent.click(screen.getAllByRole("button", { name: /^Fork .* into a fresh chat$/ })[0]);

    flush();
    const dialog = await within(document.body).findByRole("dialog");
    expect(dialog.parentElement).toBe(document.body);
    const modal = within(dialog);
    const description = await modal.findByLabelText("Description / sub-items");
    expect((description as HTMLTextAreaElement).value).toContain("Details / sub-items");
    expect(modal.getByRole("button", { name: "Start fork" })).toBeTruthy();
  });

  /*
   * A dialog you cannot leave is worse than one that never opens.
   *
   * Both exits set the same signal, so the handlers read correct, and the
   * markup renders both controls, so a screenshot reads correct too. What
   * decides it is whether the click reaches the handler at all: these are
   * `@pathscale/ui` Buttons, and that component enumerates the props it puts
   * on its root rather than spreading what it was given. An event handler that
   * is not on its list is dropped in silence, which is invisible to every
   * check short of firing the click.
   *
   * Asserted per control rather than once. They are separate call sites and a
   * fix that reconnects one can easily miss the other.
   */
  for (const exit of ["Cancel", "close"] as const) {
    it(`closes the fork dialog from ${exit}`, async () => {
      const screen = await mountHome();

      fireEvent.click(screen.getAllByRole("button", { name: /^Fork .* into a fresh chat$/ })[0]);
      flush();

      const dialog = await within(document.body).findByRole("dialog");
      const modal = within(dialog);
      // The X carries the same accessible name as Cancel, so pick by position.
      const button =
        exit === "Cancel"
          ? modal.getAllByRole("button", { name: "Cancel" }).at(-1)
          : modal.getAllByRole("button", { name: "Cancel" })[0];

      fireEvent.click(button as HTMLElement);
      flush();

      expect(within(document.body).queryByRole("dialog")).toBeNull();
    });
  }

  it("keeps item forks nested instead of adding top-level project groups", async () => {
    const screen = await mountHome();
    const title = "Phase B — engine observability (API break)";
    expect(screen.getAllByText(title)).toHaveLength(1);

    const fork = await screen.workspace.actions.forkItem("worktable-1");

    await waitFor(() => expect(screen.getAllByText(title)).toHaveLength(1));
    const open = screen.getByRole("button", { name: `Open the fork for ${title}` });
    expect(open).toBeTruthy();
    expect(open).toHaveTextContent("Forked");
    expect(open.nextElementSibling?.textContent).toMatch(/active|planning|pending|new|shipped/i);

    screen.workspace.actions.focus("home");
    flush();
    fireEvent.click(open);
    flush();
    expect(screen.workspace.state.activeKey).toBe(fork.id);
  });

  it("shows each project's turn count after its open-item count", async () => {
    const screen = await mountHome();

    expect(screen.getByText("4 open · 2 turns · 1 active")).toBeTruthy();
  });

  it("lets Recent card text shrink before its timestamp", async () => {
    const screen = await mountHome();
    const recentCard = screen
      .getAllByRole("button")
      .find((button) => button.textContent?.includes("~/src/foo.bar"));

    expect(recentCard).toBeTruthy();
    expect(recentCard?.querySelector("div")).toHaveClass("flex-1");
  });

  it("does not count canceled work as open in the group summary", async () => {
    const screen = await mountHome();

    await screen.workspace.actions.setItemStatus("worktable-0", "canceled");

    await waitFor(() => expect(screen.getByText("3 open · 2 turns")).toBeTruthy());
  });

  /*
   * The owner's request, verbatim: "Ability to manually edit a task item" —
   * on Home, where the harvested lists are actually read. The pencil swaps
   * the row for an input; Enter lands through the same update_item path the
   * agent uses, so the store (and the mock backend) see a real rename.
   */
  it("edits an item title in place", async () => {
    const screen = await mountHome();

    const pencil = screen.getAllByLabelText(/^Edit /)[0] as HTMLButtonElement;
    const title = (pencil.getAttribute("aria-label") ?? "").replace(/^Edit /, "");
    expect(title.length).toBeGreaterThan(0);

    fireEvent.click(pencil);

    flush();
    const input = document.querySelector('input[aria-label^="Edit "]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe(title);

    fireEvent.input(input, { target: { value: "Renamed from Home" } });
    // Land the typed title before Enter commits it, or the rename saves the
    // value from before the keystroke.
    flush();
    fireEvent.keyDown(input, { key: "Enter" });
    flush();

    await waitFor(() => expect(screen.getByText("Renamed from Home")).toBeTruthy());
  });

  it("escape abandons the edit and keeps the old title", async () => {
    const screen = await mountHome();

    const pencil = screen.getAllByLabelText(/^Edit /)[0] as HTMLButtonElement;
    const title = (pencil.getAttribute("aria-label") ?? "").replace(/^Edit /, "");

    fireEvent.click(pencil);

    flush();
    const input = document.querySelector('input[aria-label^="Edit "]') as HTMLInputElement;
    fireEvent.input(input, { target: { value: "should be discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });
    flush();

    await waitFor(() => expect(screen.getByText(title)).toBeTruthy());
    expect(screen.queryByText("should be discarded")).toBeNull();
  });

  /*
   * "Home tasks projects can fully expand to fill the height if there's
   * room": no group carries an inner scroll cap any more — every item row
   * renders, and the projects column is the only scroller. The 220px
   * porthole (with its Show-all footer scrolled out of its own reach) is
   * what this pins against returning.
   */
  it("renders every item with no inner scroll cap", async () => {
    const screen = await mountHome();

    const pencils = screen.getAllByLabelText(/^Edit /);
    expect(pencils.length).toBeGreaterThan(0);
    for (const pencil of pencils) {
      let node: HTMLElement | null = pencil as HTMLElement;
      while (node) {
        expect(node.className ?? "").not.toContain("max-h-[220px]");
        node = node.parentElement;
      }
    }
    expect(screen.queryByText(/^Show all \d+$/)).toBeNull();
  });

  it("deletes an item from its row", async () => {
    const screen = await mountHome();

    // By its title attribute: `Delete <name>` aria-labels also belong to the
    // project delete (which confirms in place instead of acting).
    const remove = screen.getAllByTitle("Delete this item")[0] as HTMLButtonElement;
    const title = (remove.getAttribute("aria-label") ?? "").replace(/^Delete /, "");
    expect(title.length).toBeGreaterThan(0);

    fireEvent.click(remove);
    await waitFor(() => expect(screen.queryByText(title)).toBeNull());
  });

  it("reviews a project deletion in place before removing its stored work", async () => {
    const screen = await mountHome();
    expect(screen.workspace.state.projects.some((project) => project.id === "worktable")).toBe(
      true,
    );

    fireEvent.click(screen.getByLabelText("Delete foo.bar"));
    flush();

    expect(screen.getByText("Delete?")).toBeTruthy();
    expect(screen.workspace.state.projects.some((project) => project.id === "worktable")).toBe(
      true,
    );

    const confirm = screen.getByTitle(
      "Removes this project and its transcript, items, pull requests and sessions from the store. Usage/cost history is kept.",
    );
    fireEvent.click(confirm);
    flush();

    await waitFor(() =>
      expect(screen.workspace.state.projects.some((project) => project.id === "worktable")).toBe(
        false,
      ),
    );
  });
});
