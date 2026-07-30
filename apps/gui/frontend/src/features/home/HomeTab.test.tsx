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
});
