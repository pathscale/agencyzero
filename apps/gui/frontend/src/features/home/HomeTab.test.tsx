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
   * "Task list should be able to fully expand": any group whose item count
   * exceeds what the capped window shows must offer the way out, and taking
   * it must actually lift the cap.
   */
  it("offers Show all once the cap can hide a row, and lifts it", async () => {
    const screen = await mountHome();

    const toggle = screen.getAllByText(/^Show all \d+$/)[0] as HTMLButtonElement;
    const list = toggle.closest("div");
    expect(list?.className).toContain("max-h-[220px]");

    fireEvent.click(toggle);
    expect(list?.className).not.toContain("max-h-[220px]");
    expect(screen.getAllByText("Shrink the list").length).toBeGreaterThan(0);
  });
});
