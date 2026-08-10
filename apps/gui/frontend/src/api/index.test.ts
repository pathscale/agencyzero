import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `selectApi` decides which half of the app is real, and one of its decisions
 * was silently wrong: `on` is not a command, so it fell through the per-command
 * routing and stayed the mock's in-memory emitter. Rust emitted `project:created`
 * over Tauri's bus, nothing was listening there, and a project the backend had
 * just written never reached the store — the tab rendered "This project could
 * not be loaded" for the rest of the session.
 *
 * These tests hold the wiring rather than the symptom.
 */

const invoke = vi.fn();
const listen = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...args: unknown[]) => listen(...args) }));

/** What `IMPLEMENTED` in main.rs reports today. */
const IMPLEMENTED = [
  "list_projects",
  "list_items",
  "list_messages",
  "list_running_tasks",
  "list_task_log",
  "clear_task_log",
  "list_rate_limits",
  "add_dir",
  "remove_dir",
  "create_project",
  "send_message",
  "get_settings",
  "pricing_table",
  "get_project_verbosity",
  "set_project_verbosity",
  "reset_project_session",
  "adopt_session",
  "quit_app",
  "quit_app_and_proxy",
];

describe("selectApi", () => {
  beforeEach(() => {
    invoke.mockReset();
    listen.mockReset();
    // The signal Tauri v2 injects, and what `isTauri()` reads.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockImplementation((command: string) => {
      if (command === "list_capabilities") return Promise.resolve(IMPLEMENTED);
      return Promise.resolve(undefined);
    });
    listen.mockResolvedValue(() => {});
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("subscribes on Tauri's bus, which is where Rust emits", async () => {
    const { selectApi } = await import("./index");
    const { api } = await selectApi();

    await api.on("project:created", () => {});

    expect(listen).toHaveBeenCalledWith("project:created", expect.any(Function));
  });

  /*
   * Both buses, not one. In hybrid mode a mock-served command emits on the
   * mock's emitter and a Rust-served one over Tauri's, so listening to either
   * alone drops every mutation the other half makes.
   */
  it("still delivers events raised by the mock half", async () => {
    const { selectApi } = await import("./index");
    const { api } = await selectApi();

    const seen: unknown[] = [];
    await api.on("item:created", (item) => seen.push(item));

    // `create_item` is not implemented in Rust, so the mock answers it and
    // broadcasts on its own emitter.
    await api.createItem("worktable", "Wire the task log");

    expect(seen).toHaveLength(1);
    expect(listen).toHaveBeenCalledWith("item:created", expect.any(Function));
  });

  it("unsubscribes from both when the listener is dropped", async () => {
    const tauriUnlisten = vi.fn();
    listen.mockResolvedValue(tauriUnlisten);

    const { selectApi } = await import("./index");
    const { api } = await selectApi();

    const seen: unknown[] = [];
    const unlisten = await api.on("item:created", (item) => seen.push(item));
    unlisten();

    await api.createItem("worktable", "Wire the task log");

    expect(tauriUnlisten).toHaveBeenCalled();
    expect(seen, "the mock listener is dropped too, not just the Tauri one").toHaveLength(0);
  });

  it("reports hybrid, and routes only the commands Rust claims", async () => {
    const { selectApi } = await import("./index");
    const { backend, live } = await selectApi();

    expect(backend).toBe("hybrid");
    expect(live.has("listProjects")).toBe(true);
    expect(live.has("addDir")).toBe(true);
    expect(live.has("removeDir")).toBe(true);
    expect(live.has("quitApp")).toBe(true);
    expect(live.has("quitAppAndProxy")).toBe(true);
    expect(live.has("pricingTable")).toBe(true);
    expect(live.has("resetProjectSession")).toBe(true);
    // Not in IMPLEMENTED, so it stays on the mock and the UI greys it out.
    expect(live.has("createItem")).toBe(false);
  });

  it("routes recovery and pricing to Rust instead of successful mock no-ops", async () => {
    const { selectApi } = await import("./index");
    const { api } = await selectApi();

    await api.pricingTable();
    await api.resetProjectSession("project-stuck", "codex", true);

    expect(invoke).toHaveBeenCalledWith("pricing_table", {});
    expect(invoke).toHaveBeenCalledWith("reset_project_session", {
      projectId: "project-stuck",
      agent: "codex",
      force: true,
    });
  });
});
