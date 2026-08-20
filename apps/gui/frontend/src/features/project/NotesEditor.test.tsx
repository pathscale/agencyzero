import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { flush, Show } from "solid-js";
import { describe, expect, it } from "vitest";
import { NOTES_BUDGET } from "~/api/client";
import { ProjectPanel } from "~/features/project/ProjectPanel";
import { prefs, setPrefs } from "~/stores/prefs";
import { useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";
import type { Project } from "~/types";

/*
 * These notes are standing instructions: they ride every turn and the model
 * treats them as true. That is the point of them and also the risk — an agent
 * that misread a correction, or generalised one incident into a rule, would
 * carry it for the life of the project, and the only symptom would be behaviour
 * nobody can account for.
 *
 * So this section is the safety valve, and these tests are about the valve
 * rather than the layout: can you see what is being followed, and can you strike
 * out something wrong.
 */
const PROJECT: Project = {
  id: "worktable",
  name: "WorkTable",
  status: "active",
  order: 0,
  dirs: [],
  pinned: false,
  moderatorEnabled: false,
  forkedFrom: null,
  sessionId: null,
  sessions: {},
  lastActivityAt: "2026-07-31T12:00:00.000Z",
};

/*
 * Mounted behind the boot, because the panel reads from the backend the moment
 * it appears — this section and the I/O toggle both fire a command from an
 * effect — and there is no backend to read from until `selectApi` has settled.
 * The real window has the same rule: it holds a loading screen until boot is
 * ready, so nothing renders a project panel before then either.
 */
function mount() {
  setPrefs((d) => {
    d.panelSections.notes = true;
  });
  let workspace!: Workspace;

  function Gate() {
    workspace = useWorkspace();
    return (
      <Show when={workspace.state.boot.status === "ready"}>
        <ProjectPanel project={PROJECT} agent="codex" />
      </Show>
    );
  }

  const screen = render(() => (
    <WorkspaceProvider>
      <Gate />
    </WorkspaceProvider>
  ));

  const box = () => screen.getByLabelText("Notes kept across compaction") as HTMLTextAreaElement;
  const button = (label: string) => screen.getByText(label) as HTMLButtonElement;
  const type = (text: string) => {
    fireEvent.input(box(), { target: { value: text } });
    // Solid 2 queues the draft signal the input handler writes, so a caller
    // that reads the Save button on the next line sees it still disabled.
    flush();
  };
  /** Resolves once the panel is on screen and has read from the backend. */
  const ready = async () => {
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });
    // Settled: the section's own read has landed. Only the notes section keeps
    // a box, so the settings tests wait on the panel appearing instead.
    if (prefs.panelSections.notes) await waitFor(() => expect(box().value).toBe(""));
    else await waitFor(() => expect(screen.getByText("Settings")).toBeTruthy());
  };
  return { screen, box, button, type, ready };
}

describe("the notes a compaction kept", () => {
  /*
   * An editor rather than an empty state, even with nothing kept. A box can be
   * typed into; a "nothing here yet" panel cannot, and seeding the house rules
   * before the first compaction is worth having on its own.
   */
  it("can be written by hand before any compaction has happened", async () => {
    const { box, button, type, ready } = mount();
    await ready();
    expect(box().placeholder).toContain("/compact");
    // Nothing to save until something is typed.
    expect(button("Save").disabled).toBe(true);

    type("Bump the version on every commit.");
    expect(button("Save").disabled).toBe(false);

    fireEvent.click(button("Save"));
    flush();
    await waitFor(() => expect(button("Save").disabled).toBe(true));
    expect(box().value).toBe("Bump the version on every commit.");
  });

  /*
   * The correction path, which is the reason the section exists at all: a wrong
   * rule has to be strikeable, not merely visible.
   */
  it("keeps an edit that corrects a rule", async () => {
    const { box, button, type, ready } = mount();
    await ready();

    type("Always force-push to master.");
    fireEvent.click(button("Save"));
    flush();
    await waitFor(() => expect(button("Save").disabled).toBe(true));

    type("Never force-push to master.");
    fireEvent.click(button("Save"));
    flush();
    await waitFor(() => expect(button("Save").disabled).toBe(true));
    expect(box().value).toBe("Never force-push to master.");
  });

  /*
   * Forgetting on purpose is a real thing to want: a project that changed
   * direction is better off with nothing than with rules written for the work it
   * used to be doing.
   */
  it("can forget everything, and only offers to when there is something to forget", async () => {
    const { box, button, type, ready } = mount();
    await ready();
    expect(button("Forget").disabled).toBe(true);

    type("A rule from a project that has since changed direction.");
    fireEvent.click(button("Save"));
    flush();
    await waitFor(() => expect(button("Forget").disabled).toBe(false));

    fireEvent.click(button("Forget"));
    flush();
    await waitFor(() => expect(box().value).toBe(""));
    expect(button("Forget").disabled).toBe(true);
  });

  /** Second thoughts, without having to remember what was there before. */
  it("reverts an unsaved edit to what is stored", async () => {
    const { box, button, type, ready } = mount();
    await ready();

    type("Keep this one.");
    fireEvent.click(button("Save"));
    flush();
    await waitFor(() => expect(button("Save").disabled).toBe(true));

    type("A change I did not mean to make.");
    fireEvent.click(button("Revert"));
    flush();
    await waitFor(() => expect(box().value).toBe("Keep this one."));
  });

  /*
   * Said before saving, not discovered after. The backend clamps whatever it is
   * handed, so without this the last rules typed would vanish on save and the
   * only clue would be their absence.
   */
  it("warns before saving that an oversized set will lose its oldest lines", async () => {
    const { screen, type, ready } = mount();
    await ready();

    type("x".repeat(NOTES_BUDGET + 25));
    await waitFor(() => expect(screen.getByText(/25 over/)).toBeTruthy());
    expect(screen.getByText(/oldest lines will be dropped/)).toBeTruthy();
  });

  it("shows the room left while it is still room", async () => {
    const { screen, type, ready } = mount();
    await ready();

    type("y".repeat(100));
    await waitFor(() => expect(screen.getByText(`${NOTES_BUDGET - 100} left`)).toBeTruthy());
  });
});

/*
 * A switch whose only effect is three extra billed turns, on a schedule the user
 * does not control, has to explain itself before it is flipped — and default to
 * off, so nobody pays for an experiment they did not opt into.
 */
describe("the knowledge checkpoint switch", () => {
  // `mount` opens the notes section; this opens Settings alongside it, which is
  // where the switch lives.
  const openSettings = () =>
    setPrefs((d) => {
      d.panelSections.settings = true;
    });

  it("is off until it is asked for", async () => {
    openSettings();
    const { ready, screen } = mount();
    await ready();

    const toggle = screen.getByLabelText(
      "Knowledge checkpoints for this project",
    ) as HTMLInputElement;
    await waitFor(() => expect(toggle.checked).toBe(false));
  });

  it("says what it costs and what it is for, in the settings themselves", async () => {
    openSettings();
    const { ready, screen } = mount();
    await ready();

    // The three thresholds, the price, and the reason — not a tooltip.
    expect(screen.getByText(/300k/)).toBeTruthy();
    expect(screen.getByText(/one extra turn each/)).toBeTruthy();
    expect(screen.getByText(/whether the notes get worse under pressure/)).toBeTruthy();
  });

  it("keeps the switch where it was put", async () => {
    openSettings();
    const { ready, screen } = mount();
    await ready();

    const toggle = screen.getByLabelText(
      "Knowledge checkpoints for this project",
    ) as HTMLInputElement;
    fireEvent.change(toggle, { target: { checked: true } });
    flush();
    await waitFor(() => expect(toggle.checked).toBe(true));
  });
});

describe("project response verbosity", () => {
  it("starts at model default and keeps the project-local choice", async () => {
    setPrefs((d) => {
      d.panelSections.settings = true;
    });
    const { ready, screen } = mount();
    await ready();

    const slider = screen.getByLabelText("Response verbosity for this project");
    await waitFor(() => expect(slider).toHaveAttribute("aria-valuenow", "0"));

    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    flush();
    await waitFor(() => expect(slider).toHaveAttribute("aria-valuenow", "2"));
    expect(slider).toHaveAttribute("aria-valuetext", "Medium");
    // Twice: the panel's own header, and the slider's live region, which is
    // visually hidden by the call site but present for assistive technology.
    expect(screen.getAllByText("Medium")).toHaveLength(2);
  });
});

/*
 * The budget is duplicated across the language boundary — `notes::BUDGET` in the
 * Rust is the one that binds, and this copy is what lets the editor show the
 * remaining room *before* saving. Pinned on both sides so they cannot drift
 * apart unnoticed; the Rust half is `the_budget_matches_the_window`.
 */
describe("the notes budget", () => {
  it("matches the figure the backend clamps to", () => {
    expect(NOTES_BUDGET).toBe(4_000);
  });
});
