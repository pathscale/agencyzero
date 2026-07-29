import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "~/lib/platform";
import type { AgencyZeroApi } from "./client";
import { createMockApi } from "./mock";
import { createTauriApi } from "./tauri";

export type { AgencyZeroApi, AppEvent, AppEvents, TaskLogPage, Unlisten } from "./client";

/**
 * The `AgencyZeroApi` method names, mapped to the Rust command each one invokes.
 *
 * Written out rather than derived, because the mapping is not mechanical:
 * `getSettings` is `get_settings`, but `on` is not a command at all. The
 * capability probe returns command names, and this is what turns them back into
 * the methods a caller reaches for.
 */
const COMMAND_FOR: Partial<Record<keyof AgencyZeroApi, string>> = {
  listProjects: "list_projects",
  createProject: "create_project",
  deleteProject: "delete_project",
  renameProject: "rename_project",
  setProjectStatus: "set_project_status",
  reorderProjects: "reorder_projects",
  setProjectPinned: "set_project_pinned",
  setProjectModerator: "set_project_moderator",
  forkProject: "fork_project",
  addDir: "add_dir",
  removeDir: "remove_dir",
  listItems: "list_items",
  createItem: "create_item",
  deleteItem: "delete_item",
  setItemStatus: "set_item_status",
  reorderItems: "reorder_items",
  listMessages: "list_messages",
  sendMessage: "send_message",
  resolveModeration: "resolve_moderation",
  getSettings: "get_settings",
  setSettings: "set_settings",
  listAgentStatus: "list_agent_status",
  listModels: "list_models",
  getDataLocation: "get_data_location",
  setDataLocation: "set_data_location",
  getWorkspaceRoot: "get_workspace_root",
  createWorkspaceRoot: "create_workspace_root",
  setTabModel: "set_tab_model",
  cancelRun: "cancel_run",
  listRunningTasks: "list_running_tasks",
  cancelTask: "cancel_task",
  listTaskLog: "list_task_log",
  listAgentIo: "list_agent_io",
  getIoPersist: "get_io_persist",
  setIoPersist: "set_io_persist",
  listQuota: "list_quota",
  clearTaskLog: "clear_task_log",
  listRateLimits: "list_rate_limits",
  getCostSummary: "get_cost_summary",
  getTaskManager: "get_task_manager",
  resetTaskManager: "reset_task_manager",
  resolveApproval: "resolve_approval",
};

export type BackendChoice = {
  api: AgencyZeroApi;
  backend: "tauri" | "mock" | "hybrid";
  /**
   * Which `AgencyZeroApi` methods reach Rust. Everything else is served by the
   * mock, which the UI greys out so unfinished wiring is visible rather than
   * quietly fake.
   */
  live: Set<keyof AgencyZeroApi>;
};

/**
 * Ask Rust which commands it implements.
 *
 * Returns an empty list when `list_capabilities` itself is missing, which is how
 * a build predating the probe reports "nothing yet" without failing. Any other
 * error is thrown: a backend that is present and broken must not be mistaken for
 * one that is merely unfinished.
 */
async function probeCapabilities(): Promise<Set<string>> {
  try {
    return new Set(await invoke<string[]>("list_capabilities"));
  } catch (error) {
    const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
    if (/not found|unknown command|command .* is not/i.test(text)) return new Set();
    throw error;
  }
}

/**
 * Picks a backend once, at startup, per command rather than wholesale.
 *
 * The Rust side is being built one command at a time, so "is the backend ready"
 * has no single answer. Instead Rust reports what it implements and each method
 * routes to Rust or the mock accordingly. That is what lets settings and agent
 * detection be real while projects and messages are still fixtures, without the
 * window having to choose between a backend that cannot boot it and one that
 * forgets everything.
 *
 * The alternative, probing one command as a proxy for all of them, is what this
 * replaces: implementing `get_settings` alone used to flip the whole app onto a
 * backend where `list_projects` did not exist.
 *
 * Errors are not swallowed. A command Rust claims but fails on propagates, so a
 * broken store or a rejected capability refuses to start rather than silently
 * writing to fixture state behind a banner.
 */
export async function selectApi(): Promise<BackendChoice> {
  if (!isTauri()) {
    return { api: createMockApi(), backend: "mock", live: new Set() };
  }

  const implemented = await probeCapabilities();
  const mock = createMockApi();
  if (implemented.size === 0) {
    // biome-ignore lint/suspicious/noConsole: the backend in use is worth stating plainly.
    console.warn("[agencyzero] Rust implements no commands yet, serving design fixtures");
    return { api: mock, backend: "mock", live: new Set() };
  }

  const tauri = createTauriApi();
  const live = new Set(
    (Object.keys(COMMAND_FOR) as (keyof AgencyZeroApi)[]).filter((method) => {
      const command = COMMAND_FOR[method];
      return command !== undefined && implemented.has(command);
    }),
  );

  /*
   * Bound per method at startup rather than proxied per call: `on` is not in the
   * command map and needs the special case below, and a Proxy would have to
   * carry it anyway.
   */
  const api = { ...mock } as AgencyZeroApi;
  for (const method of live) {
    Object.assign(api, { [method]: tauri[method].bind(tauri) });
  }

  /*
   * `on` subscribes to *both* buses, and that is not belt-and-braces.
   *
   * The store treats events as the source of truth — every mutation is applied
   * by the event it broadcasts, not by the command's return value. In hybrid
   * mode the two halves broadcast to different places: a mock-served command
   * emits on the mock's in-memory emitter, a Rust-served one emits over Tauri's
   * bus. Listening to only one silently drops every mutation the other half
   * makes.
   *
   * Taking the mock's alone is what made a created project vanish: Rust wrote
   * the row and emitted `project:created`, the window was listening to the mock,
   * and the store never learned the project existed — so the tab it had just
   * converted rendered "This project could not be loaded" forever.
   *
   * An event arrives once either way, since whichever backend served the command
   * is the only one that emits for it.
   */
  api.on = async (event, handler) => {
    const unlisteners = await Promise.all([mock.on(event, handler), tauri.on(event, handler)]);
    return () => {
      for (const unlisten of unlisteners) unlisten();
    };
  };

  const backend = live.size === Object.keys(COMMAND_FOR).length ? "tauri" : "hybrid";
  return { api, backend, live };
}
