import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { HomeTab } from "~/features/home/HomeTab";
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
  it("keeps item forks nested instead of adding top-level project groups", async () => {
    const screen = await mountHome();
    const title = "Phase B — engine observability (API break)";
    expect(screen.getAllByText(title)).toHaveLength(1);

    const fork = await screen.workspace.actions.forkItem("worktable-1");

    await waitFor(() => expect(screen.getAllByText(title)).toHaveLength(1));
    const open = screen.getByRole("button", { name: `Open the fork for ${title}` });
    expect(open).toBeTruthy();

    screen.workspace.actions.focus("home");
    fireEvent.click(open);
    expect(screen.workspace.state.activeKey).toBe(fork.id);
  });

  it("shows each project's turn count after its open-item count", async () => {
    const screen = await mountHome();

    expect(screen.getByText("4 open · 2 turns · 1 active")).toBeTruthy();
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
    const input = document.querySelector('input[aria-label^="Edit "]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe(title);

    fireEvent.input(input, { target: { value: "Renamed from Home" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.getByText("Renamed from Home")).toBeTruthy());
  });

  it("escape abandons the edit and keeps the old title", async () => {
    const screen = await mountHome();

    const pencil = screen.getAllByLabelText(/^Edit /)[0] as HTMLButtonElement;
    const title = (pencil.getAttribute("aria-label") ?? "").replace(/^Edit /, "");

    fireEvent.click(pencil);
    const input = document.querySelector('input[aria-label^="Edit "]') as HTMLInputElement;
    fireEvent.input(input, { target: { value: "should be discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });

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
});
